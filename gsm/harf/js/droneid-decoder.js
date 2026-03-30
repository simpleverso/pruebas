/**
 * DroneID Decoder Module
 * Contains OFDM demodulation, QPSK demodulation, descrambling, turbo decoding,
 * and DJI DroneID / ASTM F3411 RemoteID packet parsing.
 */

import { Complex, FFT, ZadoffChu, GoldSequence } from './dsp.js';
import logger from './logger.js';

const MODULE = 'DroneIDDecoder';

// OUI constants
export const DJI_OUI = [0x26, 0x37, 0x12];
export const REMOTE_ID_OUI = [0x6a, 0x5c, 0x35];

// DSP constants
export const FFT_SIZE = 2048;
export const CYCLE_PREFIX_LENGTH = 128;
export const ZC_ROOT_1 = 600;
export const ZC_ROOT_2 = 147;

export class DroneIDDecoder {
  constructor() {
    this.fft = new FFT(FFT_SIZE);
    this.zcSeq1 = ZadoffChu.generate(ZC_ROOT_1, FFT_SIZE);
    this.zcSeq2 = ZadoffChu.generate(ZC_ROOT_2, FFT_SIZE);

    // Pre-compute conjugate FFTs of ZC sequences for fast frequency-domain correlation
    this.zcFft1Conj = this.fft.forward(this.zcSeq1).map(c => c.conjugate());
    this.zcFft2Conj = this.fft.forward(this.zcSeq2).map(c => c.conjugate());

    this.frameBuffer = [];
    this.state = 'SEARCH';
    logger.info(MODULE, `DroneIDDecoder constructed: FFT_SIZE=${FFT_SIZE}, ZC roots=[${ZC_ROOT_1}, ${ZC_ROOT_2}], frequency-domain correlation enabled`);
  }

  // Process I/Q samples from HackRF
  processSamples(iqData) {
    logger.debug(MODULE, `processSamples: raw I/Q bytes=${iqData.length}`);

    // Convert uint8 I/Q to complex numbers (HackRF returns interleaved I/Q)
    const sampleCount = iqData.length >> 1;
    const samples = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const idx = i << 1;
      const iSample = (iqData[idx] - 128) / 128.0;
      const qSample = (iqData[idx + 1] - 128) / 128.0;
      samples[i] = new Complex(iSample, qSample);
    }

    logger.debug(MODULE, `processSamples: Complex samples produced=${sampleCount}`);

    // Concatenate to frame buffer
    this.frameBuffer = this.frameBuffer.concat(samples);

    // Process only ONE frame per call to keep the main thread responsive.
    // The receive loop calls us again quickly, so we'll catch up.
    if (this.frameBuffer.length >= FFT_SIZE * 2) {
      const frame = this.frameBuffer.slice(0, FFT_SIZE);
      this.frameBuffer = this.frameBuffer.slice(FFT_SIZE / 2);

      // Cap buffer to prevent unbounded growth
      if (this.frameBuffer.length > FFT_SIZE * 8) {
        logger.debug(MODULE, `processSamples: trimming buffer from ${this.frameBuffer.length} to ${FFT_SIZE * 2}`);
        this.frameBuffer = this.frameBuffer.slice(this.frameBuffer.length - FFT_SIZE * 2);
      }

      return this.processFrame(frame);
    }

    return null;
  }

  processFrame(samples) {
    // Perform FFT for OFDM demodulation
    const fftOutput = this.fft.forward(samples);

    // Frequency-domain correlation: multiply FFT(signal) * conj(FFT(ZC)), then IFFT
    // This is O(N log N) instead of O(N²) time-domain correlation
    const corr1 = this.correlateZCFreqDomain(fftOutput, this.zcFft1Conj);
    const corr2 = this.correlateZCFreqDomain(fftOutput, this.zcFft2Conj);

    // Find peak correlation values
    let peak1 = 0, peak2 = 0;
    for (let i = 0; i < corr1.length; i++) {
      if (corr1[i] > peak1) peak1 = corr1[i];
    }
    for (let i = 0; i < corr2.length; i++) {
      if (corr2[i] > peak2) peak2 = corr2[i];
    }

    logger.debug(MODULE, `processFrame: ZC correlation peak1=${peak1.toFixed(4)}, peak2=${peak2.toFixed(4)}, threshold=0.7`);

    // Signal detected if at least one ZC sequence correlates above threshold
    const signalDetected = peak1 > 0.3 || peak2 > 0.3;

    if (peak1 > 0.7 && peak2 > 0.7) {
      // Strong correlation on both — attempt full decode
      const subcarriers = this.extractSubcarriers(fftOutput);
      const bits = this.qpskDemodulate(subcarriers);
      const descrambled = this.descramble(bits);
      const decoded = this.turboDecode(descrambled);
      const packet = this.parsePacket(decoded);

      if (packet) {
        return { packet, signalDetected: true, peak1, peak2 };
      }

      // Decode failed but signal was strong
      return { packet: null, signalDetected: true, peak1, peak2 };
    }

    // Return signal detection info even without full decode
    return { packet: null, signalDetected, peak1, peak2 };
  }

  /**
   * Frequency-domain correlation: O(N log N) instead of O(N²).
   * Multiplies FFT(signal) * conj(FFT(ZC)), then IFFT, returns magnitude array.
   */
  correlateZCFreqDomain(fftSignal, zcFftConj) {
    const N = fftSignal.length;
    // Element-wise multiply in frequency domain
    const product = new Array(N);
    for (let i = 0; i < N; i++) {
      product[i] = fftSignal[i].mul(zcFftConj[i]);
    }
    // IFFT via: conj(FFT(conj(X))) / N
    const conjProduct = product.map(c => c.conjugate());
    const fftResult = this.fft.forward(conjProduct);
    const correlation = new Array(N);
    for (let i = 0; i < N; i++) {
      correlation[i] = fftResult[i].magnitude() / N;
    }
    return correlation;
  }

  // Keep original time-domain correlateZC for reference/testing
  correlateZC(fftOutput, zcSequence) {
    const correlation = [];
    for (let i = 0; i < fftOutput.length; i++) {
      let sumRe = 0, sumIm = 0;
      for (let j = 0; j < zcSequence.length && (i + j) < fftOutput.length; j++) {
        const idx = (i + j) % fftOutput.length;
        const aRe = fftOutput[idx].re, aIm = fftOutput[idx].im;
        const bRe = zcSequence[j].re, bIm = -zcSequence[j].im; // conjugate
        sumRe += aRe * bRe - aIm * bIm;
        sumIm += aRe * bIm + aIm * bRe;
      }
      correlation.push(Math.sqrt(sumRe * sumRe + sumIm * sumIm) / zcSequence.length);
    }
    return correlation;
  }

  extractSubcarriers(fftOutput) {
    // Extract data subcarriers (skip DC and guard bands)
    const subcarriers = [];
    const numSubcarriers = 600; // Active subcarriers in 802.11
    const startBin = (FFT_SIZE - numSubcarriers) / 2;

    for (let i = 0; i < numSubcarriers; i++) {
      const bin = Math.floor(startBin + i);
      if (bin >= 0 && bin < fftOutput.length) {
        subcarriers.push(fftOutput[bin]);
      }
    }

    logger.debug(MODULE, `extractSubcarriers: count=${subcarriers.length}, startBin=${startBin}`);

    return subcarriers;
  }

  qpskDemodulate(subcarriers) {
    const bits = [];

    for (const symbol of subcarriers) {
      const phase = symbol.phase();

      // QPSK constellation mapping
      // 00: π/4, 01: 3π/4, 11: 5π/4, 10: 7π/4
      if (phase >= -Math.PI / 4 && phase < Math.PI / 4) {
        bits.push(0, 0);
      } else if (phase >= Math.PI / 4 && phase < 3 * Math.PI / 4) {
        bits.push(0, 1);
      } else if (phase >= 3 * Math.PI / 4 || phase < -3 * Math.PI / 4) {
        bits.push(1, 1);
      } else {
        bits.push(1, 0);
      }
    }

    logger.debug(MODULE, `qpskDemodulate: input symbols=${subcarriers.length}, output bits=${bits.length}`);

    return bits;
  }

  descramble(bits) {
    // Gold sequence descrambling (seed from DJI protocol)
    const gold = new GoldSequence(0x1234); // Simplified seed
    const sequence = gold.generate(bits.length);

    logger.debug(MODULE, `descramble: Gold seed=0x1234, bit count=${bits.length}`);

    return bits.map((bit, i) => bit ^ sequence[i]);
  }

  turboDecode(bits) {
    // Simplified turbo decoding (interleaving reversal)
    const blockSize = 6144; // LTE turbo code block size
    const output = [];

    // Reverse sub-block interleaving
    const interleaverPattern = this.generateInterleaverPattern(blockSize);

    logger.debug(MODULE, `turboDecode: block size=${blockSize}, interleaver length=${interleaverPattern.length}`);

    for (let i = 0; i < bits.length && i < blockSize; i++) {
      output[interleaverPattern[i]] = bits[i];
    }

    return output;
  }

  generateInterleaverPattern(blockSize) {
    // LTE interleaver pattern (simplified)
    const pattern = [];
    for (let i = 0; i < blockSize; i++) {
      pattern.push((i * 31) % blockSize);
    }
    return pattern;
  }

  parsePacket(bits) {
    // Convert bits to bytes
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8 && (i + j) < bits.length; j++) {
        byte = (byte << 1) | bits[i + j];
      }
      bytes.push(byte);
    }

    logger.debug(MODULE, `parsePacket: byte count=${bytes.length}`);

    // Look for OUI signatures
    let ouiOffset = -1;
    let packetType = null;

    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === DJI_OUI[0] && bytes[i + 1] === DJI_OUI[1] && bytes[i + 2] === DJI_OUI[2]) {
        ouiOffset = i;
        packetType = 'DJI_DroneID';
        break;
      }
      if (bytes[i] === REMOTE_ID_OUI[0] && bytes[i + 1] === REMOTE_ID_OUI[1] && bytes[i + 2] === REMOTE_ID_OUI[2]) {
        ouiOffset = i;
        packetType = 'RemoteID';
        break;
      }
    }

    if (ouiOffset === -1) {
      logger.debug(MODULE, 'parsePacket: no OUI signature found in byte stream');
      return null;
    }

    logger.debug(MODULE, `parsePacket: OUI found type=${packetType}, offset=${ouiOffset}`);

    // Parse packet structure based on type
    try {
      if (packetType === 'DJI_DroneID') {
        return this.parseDJIDroneID(bytes, ouiOffset);
      } else if (packetType === 'RemoteID') {
        return this.parseRemoteID(bytes, ouiOffset);
      }
    } catch (e) {
      logger.debug(MODULE, `parsePacket: parse error: ${e.message}`);
    }

    return null;
  }

  parseDJIDroneID(bytes, offset) {
    // DJI DroneID packet structure (from reverse engineering)
    // Reference: NDSS 2023 Drone Security paper

    const packet = {
      type: 'DJI DroneID',
      protocol: 'OcuSync 2.0/3.0',
      timestamp: new Date(),
      rawBytes: bytes.slice(offset, offset + 100)
    };

    // Parse based on subcommand
    const subcommand = bytes[offset + 3];

    logger.debug(MODULE, `parseDJIDroneID: subcommand=0x${subcommand.toString(16)}`);

    if (subcommand === 0x10) {
      // Flight telemetry packet
      packet.packetType = 'Flight Telemetry';
      packet.droneLat = this.parseCoordinate(bytes, offset + 4);
      packet.droneLon = this.parseCoordinate(bytes, offset + 8);
      packet.droneAlt = this.parseInt16(bytes, offset + 12) / 10; // meters
      packet.homeLat = this.parseCoordinate(bytes, offset + 14);
      packet.homeLon = this.parseCoordinate(bytes, offset + 18);
      packet.pilotLat = this.parseCoordinate(bytes, offset + 22);
      packet.pilotLon = this.parseCoordinate(bytes, offset + 26);
      packet.speedH = this.parseInt16(bytes, offset + 30) / 10; // m/s
      packet.speedV = this.parseInt16(bytes, offset + 32) / 10; // m/s
      packet.heading = this.parseUInt16(bytes, offset + 34) / 100; // degrees

      logger.info(MODULE, `parseDJIDroneID: packetType=${packet.packetType}, droneLat=${packet.droneLat}, droneLon=${packet.droneLon}, droneAlt=${packet.droneAlt}m, homeLat=${packet.homeLat}, homeLon=${packet.homeLon}, pilotLat=${packet.pilotLat}, pilotLon=${packet.pilotLon}, speedH=${packet.speedH}m/s, speedV=${packet.speedV}m/s, heading=${packet.heading}°`);

    } else if (subcommand === 0x11) {
      // User info packet
      packet.packetType = 'User Info';
      packet.serialNumber = this.parseString(bytes, offset + 4, 16);
      packet.droneModel = this.parseDroneModel(bytes[offset + 20]);

      logger.info(MODULE, `parseDJIDroneID: packetType=${packet.packetType}, serialNumber=${packet.serialNumber}, droneModel=${packet.droneModel}`);
    }

    // Validate CRC
    const crcValid = this.verifyCRC(bytes, offset);
    packet.crcValid = crcValid;

    return packet;
  }

  parseRemoteID(bytes, offset) {
    // ASTM F3411 Remote ID format
    const packet = {
      type: 'Remote ID',
      protocol: 'ASTM F3411',
      timestamp: new Date(),
      rawBytes: bytes.slice(offset, offset + 100)
    };

    // Remote ID message type
    const msgType = bytes[offset + 3];

    logger.debug(MODULE, `parseRemoteID: msgType=0x${msgType.toString(16)}`);

    if (msgType === 0x00) {
      // Basic ID
      packet.packetType = 'Basic ID';
      packet.uasId = this.parseString(bytes, offset + 4, 20);
      packet.uasType = bytes[offset + 24];
      packet.idType = bytes[offset + 25];

      logger.info(MODULE, `parseRemoteID: packetType=${packet.packetType}, uasId=${packet.uasId}, uasType=${packet.uasType}, idType=${packet.idType}`);

    } else if (msgType === 0x01) {
      // Location/Vector
      packet.packetType = 'Location';
      packet.status = bytes[offset + 4];
      packet.droneLat = this.parseCoordinate(bytes, offset + 5);
      packet.droneLon = this.parseCoordinate(bytes, offset + 9);
      packet.droneAlt = this.parseInt16(bytes, offset + 13) / 10;
      packet.height = this.parseInt16(bytes, offset + 15) / 10;
      packet.speedH = bytes[offset + 17]; // m/s
      packet.course = this.parseUInt16(bytes, offset + 18) / 10;

      logger.info(MODULE, `parseRemoteID: packetType=${packet.packetType}, status=${packet.status}, droneLat=${packet.droneLat}, droneLon=${packet.droneLon}, droneAlt=${packet.droneAlt}m, height=${packet.height}m, speedH=${packet.speedH}m/s, course=${packet.course}°`);

    } else if (msgType === 0x04) {
      // System message (operator location)
      packet.packetType = 'System';
      packet.operatorLat = this.parseCoordinate(bytes, offset + 5);
      packet.operatorLon = this.parseCoordinate(bytes, offset + 9);

      logger.info(MODULE, `parseRemoteID: packetType=${packet.packetType}, operatorLat=${packet.operatorLat}, operatorLon=${packet.operatorLon}`);
    }

    return packet;
  }

  // Helper parsing functions
  parseCoordinate(bytes, offset) {
    // IEEE 754 single precision or int32 coordinate format
    const intVal = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
                   (bytes[offset + 2] << 8) | bytes[offset + 3];
    return intVal / 10000000; // Convert to degrees
  }

  parseInt16(bytes, offset) {
    const val = (bytes[offset] << 8) | bytes[offset + 1];
    return val > 32767 ? val - 65536 : val;
  }

  parseUInt16(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  parseString(bytes, offset, length) {
    let str = '';
    for (let i = 0; i < length && bytes[offset + i] !== 0; i++) {
      str += String.fromCharCode(bytes[offset + i]);
    }
    return str;
  }

  parseDroneModel(code) {
    const models = {
      0x01: 'Mavic 3',
      0x02: 'Mavic Air 2',
      0x03: 'Mini 2',
      0x04: 'Mini 3 Pro',
      0x05: 'Air 2S',
      0x06: 'FPV',
      0x07: 'Mavic 3 Pro',
      0x08: 'Mini 4 Pro',
      0x09: 'Air 3',
      0x0A: 'Mavic 3 Classic'
    };
    return models[code] || `Unknown (0x${code.toString(16)})`;
  }

  verifyCRC(bytes, offset) {
    // Simplified CRC check (DJI uses CRC-16-CCITT)
    return true; // Placeholder
  }
}

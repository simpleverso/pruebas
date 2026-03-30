/**
 * DSP Module
 * Contains Complex number operations, FFT (Cooley-Tukey), Zadoff-Chu sequence generation,
 * and Gold sequence generation classes.
 */

import logger from './logger.js';

const MODULE = 'DSP';

// Complex number operations
export class Complex {
  constructor(re = 0, im = 0) {
    this.re = re;
    this.im = im;
  }

  add(other) {
    return new Complex(this.re + other.re, this.im + other.im);
  }

  sub(other) {
    return new Complex(this.re - other.re, this.im - other.im);
  }

  mul(other) {
    return new Complex(
      this.re * other.re - this.im * other.im,
      this.re * other.im + this.im * other.re
    );
  }

  magnitude() {
    return Math.sqrt(this.re * this.re + this.im * this.im);
  }

  phase() {
    return Math.atan2(this.im, this.re);
  }

  conjugate() {
    return new Complex(this.re, -this.im);
  }
}

// FFT Implementation (Cooley-Tukey)
export class FFT {
  constructor(size) {
    this.size = size;
    this.bitReversedIndices = this.computeBitReversedIndices();
    logger.info(MODULE, `FFT constructed: size=${size}, bit-reversed indices count=${this.bitReversedIndices.length}`);
  }

  computeBitReversedIndices() {
    const indices = new Array(this.size);
    const bits = Math.log2(this.size);
    for (let i = 0; i < this.size; i++) {
      let reversed = 0;
      for (let j = 0; j < bits; j++) {
        reversed = (reversed << 1) | ((i >> j) & 1);
      }
      indices[i] = reversed;
    }
    return indices;
  }

  forward(input) {
    const startTime = performance.now();
    const stages = Math.log2(this.size);
    const output = new Array(this.size);

    // Bit-reversal permutation
    for (let i = 0; i < this.size; i++) {
      output[this.bitReversedIndices[i]] = input[i];
    }

    // Butterfly operations
    for (let stage = 1; stage <= stages; stage++) {
      const step = 1 << stage;
      const halfStep = step >> 1;

      for (let group = 0; group < this.size; group += step) {
        for (let k = 0; k < halfStep; k++) {
          const angle = -2 * Math.PI * k / step;
          const twiddle = new Complex(Math.cos(angle), Math.sin(angle));

          const even = output[group + k];
          const odd = output[group + k + halfStep].mul(twiddle);

          output[group + k] = even.add(odd);
          output[group + k + halfStep] = even.sub(odd);
        }
      }
    }

    const elapsed = performance.now() - startTime;
    logger.debug(MODULE, `FFT.forward: input length=${input.length}, stages=${stages}, execution time=${elapsed.toFixed(3)}ms`);

    return output;
  }
}

// Zadoff-Chu Sequence Generator (for synchronization)
export class ZadoffChu {
  static generate(root, length) {
    const startTime = performance.now();
    const sequence = new Array(length);
    for (let n = 0; n < length; n++) {
      const angle = -Math.PI * root * n * (n + 1) / length;
      sequence[n] = new Complex(Math.cos(angle), Math.sin(angle));
    }
    const elapsed = performance.now() - startTime;
    logger.debug(MODULE, `ZadoffChu.generate: root=${root}, length=${length}, execution time=${elapsed.toFixed(3)}ms`);
    return sequence;
  }
}

// Gold Sequence Generator (for descrambling)
export class GoldSequence {
  constructor(seed) {
    this.lfsr1 = seed & 0x7FFF;
    this.lfsr2 = (seed >> 15) & 0x7FFF;
    logger.debug(MODULE, `GoldSequence constructed: seed=0x${seed.toString(16)}, lfsr1=0x${this.lfsr1.toString(16)}, lfsr2=0x${this.lfsr2.toString(16)}`);
  }

  next() {
    const output1 = (this.lfsr1 >> 14) & 1;
    const output2 = (this.lfsr2 >> 14) & 1;

    const newBit1 = ((this.lfsr1 >> 13) ^ (this.lfsr1 >> 14)) & 1;
    this.lfsr1 = ((this.lfsr1 << 1) | newBit1) & 0x7FFF;

    const newBit2 = ((this.lfsr2 >> 12) ^ (this.lfsr2 >> 13) ^ (this.lfsr2 >> 14)) & 1;
    this.lfsr2 = ((this.lfsr2 << 1) | newBit2) & 0x7FFF;

    return output1 ^ output2;
  }

  generate(length) {
    const startTime = performance.now();
    const sequence = [];
    for (let i = 0; i < length; i++) {
      sequence.push(this.next());
    }
    const elapsed = performance.now() - startTime;
    logger.debug(MODULE, `GoldSequence.generate: length=${length}, execution time=${elapsed.toFixed(3)}ms`);
    return sequence;
  }
}

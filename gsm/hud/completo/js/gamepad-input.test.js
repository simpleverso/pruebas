// gamepad-input.test.js — Unit tests for GamepadInput
// Tests: dead-zone, state computation, override logic, fallback selection

import { describe, it, expect } from 'vitest';
import './gamepad-input.js';

const GamepadInput = globalThis.GamepadInput;

describe('GamepadInput', () => {
  describe('_applyDeadZone', () => {
    it('returns 0 for values within dead-zone', () => {
      expect(GamepadInput._applyDeadZone(0.1, 0.15)).toBe(0);
      expect(GamepadInput._applyDeadZone(-0.1, 0.15)).toBe(0);
      expect(GamepadInput._applyDeadZone(0, 0.15)).toBe(0);
    });

    it('returns 0 at exactly the dead-zone boundary', () => {
      expect(GamepadInput._applyDeadZone(0.15, 0.15)).toBe(0);
      expect(GamepadInput._applyDeadZone(-0.15, 0.15)).toBe(0);
    });

    it('scales values beyond dead-zone proportionally', () => {
      // With dz=0.15, value=1.0 should map to 1.0
      const result = GamepadInput._applyDeadZone(1.0, 0.15);
      expect(result).toBeCloseTo(1.0, 5);
    });

    it('preserves sign for negative values beyond dead-zone', () => {
      const result = GamepadInput._applyDeadZone(-1.0, 0.15);
      expect(result).toBeCloseTo(-1.0, 5);
    });

    it('returns small positive value just beyond dead-zone', () => {
      const result = GamepadInput._applyDeadZone(0.2, 0.15);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(0.15);
    });
  });

  describe('_computeState', () => {
    const defaultMappings = {
      panAxis: 0,
      tiltAxis: 1,
      zoomAxis: 3,
      toggleTrackingButton: 4,
      lockTargetButton: 5,
      recordButton: 0
    };

    it('maps axes correctly with dead-zone applied', () => {
      const raw = {
        axes: [0.5, -0.8, 0, 0.9],
        buttons: []
      };
      const state = GamepadInput._computeState(raw, defaultMappings, 0.15);
      expect(state.panAxis).toBeGreaterThan(0);
      expect(state.tiltAxis).toBeLessThan(0);
      expect(state.zoomAxis).toBeGreaterThan(0);
    });

    it('returns zero axes when all within dead-zone', () => {
      const raw = {
        axes: [0.05, -0.1, 0, 0.02],
        buttons: []
      };
      const state = GamepadInput._computeState(raw, defaultMappings, 0.15);
      expect(state.panAxis).toBe(0);
      expect(state.tiltAxis).toBe(0);
      expect(state.zoomAxis).toBe(0);
    });

    it('reads button pressed states', () => {
      const raw = {
        axes: [0, 0, 0, 0],
        buttons: [
          { pressed: true },   // 0 = record
          { pressed: false },  // 1
          { pressed: false },  // 2
          { pressed: false },  // 3
          { pressed: true },   // 4 = toggleTracking
          { pressed: false }   // 5 = lockTarget
        ]
      };
      const state = GamepadInput._computeState(raw, defaultMappings, 0.15);
      expect(state.buttons.record).toBe(true);
      expect(state.buttons.toggleTracking).toBe(true);
      expect(state.buttons.lockTarget).toBe(false);
    });

    it('handles missing axes gracefully', () => {
      const raw = { axes: [], buttons: [] };
      const state = GamepadInput._computeState(raw, defaultMappings, 0.15);
      expect(state.panAxis).toBe(0);
      expect(state.tiltAxis).toBe(0);
      expect(state.zoomAxis).toBe(0);
    });

    it('handles missing buttons gracefully', () => {
      const raw = { axes: [0, 0, 0, 0], buttons: [] };
      const state = GamepadInput._computeState(raw, defaultMappings, 0.15);
      expect(state.buttons.toggleTracking).toBe(false);
      expect(state.buttons.lockTarget).toBe(false);
      expect(state.buttons.record).toBe(false);
    });
  });

  describe('_computeOverride', () => {
    it('starts override when sticks active and not currently overriding', () => {
      const result = GamepadInput._computeOverride(0.5, 0, 0, false);
      expect(result.overriding).toBe(true);
      expect(result.action).toBe('start');
    });

    it('triggers hold-delay when sticks return to dead-zone while overriding', () => {
      const result = GamepadInput._computeOverride(0, 0, 0, true);
      expect(result.overriding).toBe(true);
      expect(result.action).toBe('hold-delay');
    });

    it('stays in override with no action when sticks still active', () => {
      const result = GamepadInput._computeOverride(0.3, 0.2, 0, true);
      expect(result.overriding).toBe(true);
      expect(result.action).toBe('none');
    });

    it('stays not overriding when sticks inactive and not overriding', () => {
      const result = GamepadInput._computeOverride(0, 0, 0, false);
      expect(result.overriding).toBe(false);
      expect(result.action).toBe('none');
    });

    it('detects override from zoom axis alone', () => {
      const result = GamepadInput._computeOverride(0, 0, 0.7, false);
      expect(result.overriding).toBe(true);
      expect(result.action).toBe('start');
    });
  });

  describe('_selectFallback', () => {
    it('selects next available gamepad on disconnect', () => {
      const list = [
        { index: 0, name: 'Gamepad A' },
        { index: 1, name: 'Gamepad B' }
      ];
      const result = GamepadInput._selectFallback(list, 0);
      expect(result.fallbackIndex).toBe(1);
      expect(result.newStatus).toBe('fallback-active');
    });

    it('returns none when no other gamepads available', () => {
      const list = [{ index: 0, name: 'Gamepad A' }];
      const result = GamepadInput._selectFallback(list, 0);
      expect(result.fallbackIndex).toBeNull();
      expect(result.newStatus).toBe('none');
    });

    it('returns none for empty list', () => {
      const result = GamepadInput._selectFallback([], 0);
      expect(result.fallbackIndex).toBeNull();
      expect(result.newStatus).toBe('none');
    });

    it('returns none for null list', () => {
      const result = GamepadInput._selectFallback(null, 0);
      expect(result.fallbackIndex).toBeNull();
      expect(result.newStatus).toBe('none');
    });

    it('selects first non-active gamepad', () => {
      const list = [
        { index: 2, name: 'Gamepad C' },
        { index: 3, name: 'Gamepad D' }
      ];
      const result = GamepadInput._selectFallback(list, 2);
      expect(result.fallbackIndex).toBe(3);
      expect(result.newStatus).toBe('fallback-active');
    });
  });

  describe('module API', () => {
    it('exports all required methods', () => {
      expect(typeof GamepadInput.init).toBe('function');
      expect(typeof GamepadInput.enumerateGamepads).toBe('function');
      expect(typeof GamepadInput.selectGamepad).toBe('function');
      expect(typeof GamepadInput.poll).toBe('function');
      expect(typeof GamepadInput.isOverriding).toBe('function');
      expect(typeof GamepadInput.onOverrideStart).toBe('function');
      expect(typeof GamepadInput.onOverrideEnd).toBe('function');
      expect(typeof GamepadInput.start).toBe('function');
      expect(typeof GamepadInput.stop).toBe('function');
      expect(typeof GamepadInput.getStatus).toBe('function');
    });
  });
});

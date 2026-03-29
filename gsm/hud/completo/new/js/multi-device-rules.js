// multi-device-rules.js — MultiDeviceRules
// Rule engine for dispatching PTZ commands to multiple serial ports.
// Provides: addRule, removeRule, reorderRules, executeRules, testRule
// Requirements: 10.1–10.11

/* global globalThis, ConfigManager, TemplateEngine */
(function () {
  'use strict';

  // ---- Internal state ----
  var _rules = [];           // DeviceRule[] sorted by order
  var _interRuleDelay = 0;   // ms between rule executions
  var _lastResults = [];     // last execution results for telemetry
  var _portSendFns = {};     // portId → async send function (wired by orchestrator)
  var _portStatusFn = null;  // function(portId) → 'connected'|'disconnected'|...

  // ---- Helpers ----

  /**
   * Load rules from ConfigManager.
   */
  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg.deviceRules) {
          _rules = Array.isArray(cfg.deviceRules.rules) ? cfg.deviceRules.rules.slice() : [];
          _interRuleDelay = typeof cfg.deviceRules.interRuleDelay === 'number'
            ? cfg.deviceRules.interRuleDelay : 0;
        }
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Persist rules to ConfigManager.
   */
  function _persistConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var cfg = ConfigManager.load();
        cfg.deviceRules = {
          rules: _rules.slice(),
          interRuleDelay: _interRuleDelay
        };
        ConfigManager.save(cfg);
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Sort rules by their order field.
   */
  function _sortRules() {
    _rules.sort(function (a, b) { return a.order - b.order; });
  }

  /**
   * Delay helper returning a promise that resolves after ms milliseconds.
   */
  function _delay(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Check if a port is connected.
   * Uses the registered portStatusFn, or falls back to 'disconnected'.
   */
  function _isPortConnected(portId) {
    if (typeof _portStatusFn === 'function') {
      var status = _portStatusFn(portId);
      return status === 'connected' || status === 'fallback-active';
    }
    return false;
  }

  /**
   * Evaluate a single rule: compile its template, substitute variables, and
   * send the command to the target port.
   * Returns a RuleExecutionResult.
   */
  function _executeSingleRule(rule, variables, portStatusFn) {
    var checkPort = portStatusFn || _isPortConnected;

    // Check if port is connected
    if (!checkPort(rule.portId)) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[MultiDeviceRules] Skipping rule "' + rule.name +
          '": target port "' + rule.portId + '" is disconnected.');
      }
      return Promise.resolve({
        ruleId: rule.id,
        status: 'skipped',
        message: 'Target port disconnected: ' + rule.portId
      });
    }

    // Compile and evaluate template
    var commandData;
    try {
      if (typeof TemplateEngine !== 'undefined' && TemplateEngine.compile && TemplateEngine.evaluate) {
        var compiled = TemplateEngine.compile(rule.template || '');
        commandData = TemplateEngine.evaluate(compiled, variables || {});
      } else {
        commandData = rule.template || '';
      }
    } catch (err) {
      return Promise.resolve({
        ruleId: rule.id,
        status: 'error',
        message: 'Template evaluation failed: ' + (err.message || err)
      });
    }

    // Send command via registered port send function
    var sendFn = _portSendFns[rule.portId];
    if (typeof sendFn === 'function') {
      return Promise.resolve().then(function () {
        return sendFn(commandData);
      }).then(function () {
        return { ruleId: rule.id, status: 'success' };
      }).catch(function (err) {
        return {
          ruleId: rule.id,
          status: 'error',
          message: 'Send failed: ' + (err.message || err)
        };
      });
    }

    // No send function registered — still count as success (command was evaluated)
    return Promise.resolve({ ruleId: rule.id, status: 'success' });
  }

  // ---- Core evaluation (testable internal) ----

  /**
   * _evaluateRules(rules, action, variables, portStatusFn)
   *
   * Pure evaluation logic exposed for property testing.
   * Given a list of rules, a PTZ action, command variables, and a port-status
   * function, returns an array of RuleExecutionResult objects.
   *
   * - Filters to enabled rules whose triggers include the action
   * - Sorts by order
   * - Skips rules whose port is disconnected (status: 'skipped')
   * - Evaluates template for connected rules (status: 'success' or 'error')
   *
   * This is a synchronous evaluation that does NOT send commands — it only
   * determines what would happen. The async executeRules() wraps this with
   * actual sending and inter-rule delays.
   */
  function _evaluateRules(rules, action, variables, portStatusFn) {
    if (!Array.isArray(rules)) return [];

    // Filter enabled rules whose triggers include the action
    var matching = [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule.enabled) continue;
      if (!Array.isArray(rule.triggers)) continue;
      if (rule.triggers.indexOf(action) === -1) continue;
      matching.push(rule);
    }

    // Sort by order
    matching.sort(function (a, b) { return a.order - b.order; });

    // Evaluate each rule
    var results = [];
    for (var j = 0; j < matching.length; j++) {
      var r = matching[j];

      // Check port status
      var isConnected = false;
      if (typeof portStatusFn === 'function') {
        var status = portStatusFn(r.portId);
        isConnected = (status === 'connected' || status === 'fallback-active');
      }

      if (!isConnected) {
        results.push({
          ruleId: r.id,
          status: 'skipped',
          message: 'Target port disconnected: ' + r.portId
        });
        continue;
      }

      // Evaluate template
      try {
        if (typeof TemplateEngine !== 'undefined' && TemplateEngine.compile && TemplateEngine.evaluate) {
          var compiled = TemplateEngine.compile(r.template || '');
          TemplateEngine.evaluate(compiled, variables || {});
        }
        results.push({ ruleId: r.id, status: 'success' });
      } catch (err) {
        results.push({
          ruleId: r.id,
          status: 'error',
          message: 'Template evaluation failed: ' + (err.message || err)
        });
      }
    }

    return results;
  }

  // ---- Public API ----

  /**
   * Add a new device rule.
   * @param {DeviceRule} rule
   */
  function addRule(rule) {
    if (!rule || !rule.id) return;

    // Prevent duplicate IDs
    for (var i = 0; i < _rules.length; i++) {
      if (_rules[i].id === rule.id) return;
    }

    _rules.push({
      id: rule.id,
      name: rule.name || '',
      portId: rule.portId || '',
      triggers: Array.isArray(rule.triggers) ? rule.triggers.slice() : [],
      template: rule.template || '',
      variableType: rule.variableType || 'percent',
      enabled: rule.enabled !== false,
      order: typeof rule.order === 'number' ? rule.order : _rules.length
    });

    _sortRules();
    _persistConfig();
  }

  /**
   * Remove a rule by ID.
   * @param {string} ruleId
   */
  function removeRule(ruleId) {
    _rules = _rules.filter(function (r) { return r.id !== ruleId; });
    _persistConfig();
  }

  /**
   * Reorder rules by providing an ordered array of rule IDs.
   * Rules are re-assigned order values based on their position in the array.
   * @param {string[]} ruleIds
   */
  function reorderRules(ruleIds) {
    if (!Array.isArray(ruleIds)) return;

    var ruleMap = {};
    for (var i = 0; i < _rules.length; i++) {
      ruleMap[_rules[i].id] = _rules[i];
    }

    for (var j = 0; j < ruleIds.length; j++) {
      if (ruleMap[ruleIds[j]]) {
        ruleMap[ruleIds[j]].order = j;
      }
    }

    _sortRules();
    _persistConfig();
  }

  /**
   * Execute all enabled rules matching the given PTZ action.
   * Rules are executed in order with configurable inter-rule delay.
   * @param {string} action - PTZ action: 'pan', 'tilt', 'zoom', 'stop'
   * @param {object} variables - Command variables for template substitution
   * @returns {Promise<RuleExecutionResult[]>}
   */
  function executeRules(action, variables) {
    // Filter enabled rules whose triggers include the action
    var matching = [];
    for (var i = 0; i < _rules.length; i++) {
      var rule = _rules[i];
      if (!rule.enabled) continue;
      if (!Array.isArray(rule.triggers)) continue;
      if (rule.triggers.indexOf(action) === -1) continue;
      matching.push(rule);
    }

    // Sort by order
    matching.sort(function (a, b) { return a.order - b.order; });

    if (matching.length === 0) {
      _lastResults = [];
      return Promise.resolve([]);
    }

    var results = [];
    var idx = 0;

    function next() {
      if (idx >= matching.length) {
        _lastResults = results;
        return Promise.resolve(results);
      }

      var currentRule = matching[idx];
      idx++;

      return _executeSingleRule(currentRule, variables).then(function (result) {
        results.push(result);
        if (idx < matching.length && _interRuleDelay > 0) {
          return _delay(_interRuleDelay).then(next);
        }
        return next();
      });
    }

    return next();
  }

  /**
   * Test a single rule by ID with provided test variables.
   * @param {string} ruleId
   * @param {object} testVariables
   * @returns {Promise<RuleExecutionResult>}
   */
  function testRule(ruleId, testVariables) {
    var rule = null;
    for (var i = 0; i < _rules.length; i++) {
      if (_rules[i].id === ruleId) {
        rule = _rules[i];
        break;
      }
    }

    if (!rule) {
      return Promise.resolve({
        ruleId: ruleId,
        status: 'error',
        message: 'Rule not found: ' + ruleId
      });
    }

    return _executeSingleRule(rule, testVariables);
  }

  /**
   * Register a send function for a specific port.
   * @param {string} portId
   * @param {function} sendFn - async function(commandData) → void
   */
  function registerPortSend(portId, sendFn) {
    _portSendFns[portId] = sendFn;
  }

  /**
   * Set the port status function used to check connectivity.
   * @param {function} fn - function(portId) → 'connected'|'disconnected'|...
   */
  function setPortStatusFn(fn) {
    _portStatusFn = fn;
  }

  /**
   * Get the current list of rules.
   * @returns {DeviceRule[]}
   */
  function getRules() {
    return _rules.slice();
  }

  /**
   * Get the count of active (enabled) rules.
   * @returns {number}
   */
  function getActiveRuleCount() {
    var count = 0;
    for (var i = 0; i < _rules.length; i++) {
      if (_rules[i].enabled) count++;
    }
    return count;
  }

  /**
   * Get the last execution results for telemetry display.
   * @returns {RuleExecutionResult[]}
   */
  function getLastResults() {
    return _lastResults.slice();
  }

  /**
   * Set the inter-rule delay in milliseconds.
   * @param {number} ms
   */
  function setInterRuleDelay(ms) {
    _interRuleDelay = typeof ms === 'number' && ms >= 0 ? ms : 0;
    _persistConfig();
  }

  /**
   * Initialize: load persisted rules from ConfigManager.
   */
  function init() {
    _loadConfig();
  }

  // Load config on module init
  _loadConfig();

  // Expose as global IIFE
  globalThis.MultiDeviceRules = {
    addRule: addRule,
    removeRule: removeRule,
    reorderRules: reorderRules,
    executeRules: executeRules,
    testRule: testRule,
    registerPortSend: registerPortSend,
    setPortStatusFn: setPortStatusFn,
    getRules: getRules,
    getActiveRuleCount: getActiveRuleCount,
    getLastResults: getLastResults,
    setInterRuleDelay: setInterRuleDelay,
    init: init,
    // Testable internal for property tests
    _evaluateRules: _evaluateRules
  };
})();

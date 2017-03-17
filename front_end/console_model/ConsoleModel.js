/*
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * @implements {SDK.TargetManager.Observer}
 */
ConsoleModel.ConsoleModel = class extends Common.Object {
  constructor() {
    super();

    /** @type {!Array.<!ConsoleModel.ConsoleMessage>} */
    this._messages = [];
    /** @type {!Map<!SDK.Target, !Map<number, !ConsoleModel.ConsoleMessage>>} */
    this._messageByExceptionId = new Map();
    this._warnings = 0;
    this._errors = 0;

    SDK.targetManager.observeTargets(this);
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetAdded(target) {
    var eventListeners = [];

    var logModel = target.model(SDK.LogModel);
    if (logModel)
      eventListeners.push(logModel.on(SDK.LogModel.EntryAddedEvent, this._logEntryAdded, this));

    var cpuProfilerModel = target.model(SDK.CPUProfilerModel);
    if (cpuProfilerModel) {
      eventListeners.push(cpuProfilerModel.addEventListener(
          SDK.CPUProfilerModel.Events.ConsoleProfileStarted, this._consoleProfileStarted.bind(this, cpuProfilerModel)));
      eventListeners.push(cpuProfilerModel.addEventListener(
          SDK.CPUProfilerModel.Events.ConsoleProfileFinished,
          this._consoleProfileFinished.bind(this, cpuProfilerModel)));
    }

    var resourceTreeModel = target.model(SDK.ResourceTreeModel);
    if (resourceTreeModel) {
      eventListeners.push(resourceTreeModel.addEventListener(
          SDK.ResourceTreeModel.Events.MainFrameStartedLoading, this._mainFrameStartedLoading, this));
      eventListeners.push(resourceTreeModel.addEventListener(
          SDK.ResourceTreeModel.Events.MainFrameNavigated, this._mainFrameNavigated, this));
    }

    var runtimeModel = target.model(SDK.RuntimeModel);
    if (runtimeModel) {
      eventListeners.push(runtimeModel.addEventListener(
          SDK.RuntimeModel.Events.ExceptionThrown, this._exceptionThrown.bind(this, runtimeModel)));
      eventListeners.push(runtimeModel.addEventListener(
          SDK.RuntimeModel.Events.ExceptionRevoked, this._exceptionRevoked.bind(this, runtimeModel)));
      eventListeners.push(runtimeModel.addEventListener(
          SDK.RuntimeModel.Events.ConsoleAPICalled, this._consoleAPICalled.bind(this, runtimeModel)));
    }

    var networkManager = target.model(SDK.NetworkManager);
    if (networkManager) {
      eventListeners.push(networkManager.addEventListener(
          SDK.NetworkManager.Events.WarningGenerated, this._networkWarningGenerated.bind(this, networkManager)));
    }

    target[ConsoleModel.ConsoleModel._events] = eventListeners;
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetRemoved(target) {
    this._messageByExceptionId.delete(target);
    Common.EventTarget.removeEventListeners(target[ConsoleModel.ConsoleModel._events]);
  }

  /**
   * @param {!SDK.ExecutionContext} executionContext
   * @param {string} text
   * @param {boolean} useCommandLineAPI
   */
  evaluateCommandInConsole(executionContext, text, useCommandLineAPI) {
    var target = executionContext.target();
    var requestedText = text;

    var commandMessage = new ConsoleModel.ConsoleMessage(
        target, ConsoleModel.ConsoleMessage.MessageSource.JS, null, text,
        ConsoleModel.ConsoleMessage.MessageType.Command);
    commandMessage.setExecutionContextId(executionContext.id);
    this.addMessage(commandMessage);

    /**
     * @param {?SDK.RemoteObject} result
     * @param {!Protocol.Runtime.ExceptionDetails=} exceptionDetails
     * @this {ConsoleModel.ConsoleModel}
     */
    function printResult(result, exceptionDetails) {
      if (!result)
        return;

      Common.console.showPromise().then(() => {
        this.dispatchEventToListeners(
            ConsoleModel.ConsoleModel.Events.CommandEvaluated,
            {result: result, text: requestedText, commandMessage: commandMessage, exceptionDetails: exceptionDetails});
      });
    }

    /**
     * @param {string} code
     * @suppress {uselessCode}
     * @return {boolean}
     */
    function looksLikeAnObjectLiteral(code) {
      // Only parenthesize what appears to be an object literal.
      if (!(/^\s*\{/.test(code) && /\}\s*$/.test(code)))
        return false;

      try {
        // Check if the code can be interpreted as an expression.
        Function('return ' + code + ';');

        // No syntax error! Does it work parenthesized?
        Function('(' + code + ')');

        return true;
      } catch (e) {
        return false;
      }
    }

    if (looksLikeAnObjectLiteral(text))
      text = '(' + text + ')';

    executionContext.evaluate(text, 'console', useCommandLineAPI, false, false, true, true, printResult.bind(this));
    Host.userMetrics.actionTaken(Host.UserMetrics.Action.ConsoleEvaluated);
  }

  /**
   * @param {!ConsoleModel.ConsoleMessage} msg
   */
  addMessage(msg) {
    if (msg.source === ConsoleModel.ConsoleMessage.MessageSource.Worker && SDK.targetManager.targetById(msg.workerId))
      return;

    if (msg.source === ConsoleModel.ConsoleMessage.MessageSource.ConsoleAPI &&
        msg.type === ConsoleModel.ConsoleMessage.MessageType.Clear)
      this._clear();

    this._messages.push(msg);
    if (msg._exceptionId && msg.target()) {
      // TODO(dgozman): make target non-nullable, as we only have messages without a target
      // internally in ConsoleView.
      var target = /** @type {!SDK.Target} */ (msg.target());
      var targetMap = this._messageByExceptionId.get(target);
      if (!targetMap) {
        targetMap = new Map();
        this._messageByExceptionId.set(target, targetMap);
      }
      targetMap.set(msg._exceptionId, msg);
    }
    this._incrementErrorWarningCount(msg);
    this.dispatchEventToListeners(ConsoleModel.ConsoleModel.Events.MessageAdded, msg);
  }

  /**
   * @param {!SDK.LogModel.EntryAddedEvent} event
   */
  _logEntryAdded(event) {
    var consoleMessage = new ConsoleModel.ConsoleMessage(
        event.logModel.target(), event.entry.source, event.entry.level, event.entry.text, undefined, event.entry.url,
        event.entry.lineNumber, undefined, event.entry.networkRequestId, undefined, event.entry.stackTrace,
        event.entry.timestamp, undefined, undefined, event.entry.workerId);
    this.addMessage(consoleMessage);
  }

  /**
   * @param {!SDK.RuntimeModel} runtimeModel
   * @param {!Common.Event} event
   */
  _exceptionThrown(runtimeModel, event) {
    var exceptionWithTimestamp = /** @type {!SDK.RuntimeModel.ExceptionWithTimestamp} */ (event.data);
    var consoleMessage = ConsoleModel.ConsoleMessage.fromException(
        runtimeModel.target(), exceptionWithTimestamp.details, undefined, exceptionWithTimestamp.timestamp, undefined);
    consoleMessage.setExceptionId(exceptionWithTimestamp.details.exceptionId);
    this.addMessage(consoleMessage);
  }

  /**
   * @param {!SDK.RuntimeModel} runtimeModel
   * @param {!Common.Event} event
   */
  _exceptionRevoked(runtimeModel, event) {
    var exceptionId = /** @type {number} */ (event.data);
    var targetMap = this._messageByExceptionId.get(runtimeModel.target());
    var exceptionMessage = targetMap ? targetMap.get(exceptionId) : null;
    if (!exceptionMessage)
      return;
    this._errors--;
    exceptionMessage.level = ConsoleModel.ConsoleMessage.MessageLevel.Info;
    this.dispatchEventToListeners(ConsoleModel.ConsoleModel.Events.MessageUpdated, exceptionMessage);
  }

  /**
   * @param {!SDK.RuntimeModel} runtimeModel
   * @param {!Common.Event} event
   */
  _consoleAPICalled(runtimeModel, event) {
    var call = /** @type {!SDK.RuntimeModel.ConsoleAPICall} */ (event.data);
    var level = ConsoleModel.ConsoleMessage.MessageLevel.Info;
    if (call.type === ConsoleModel.ConsoleMessage.MessageType.Debug)
      level = ConsoleModel.ConsoleMessage.MessageLevel.Verbose;
    else if (
        call.type === ConsoleModel.ConsoleMessage.MessageType.Error ||
        call.type === ConsoleModel.ConsoleMessage.MessageType.Assert)
      level = ConsoleModel.ConsoleMessage.MessageLevel.Error;
    else if (call.type === ConsoleModel.ConsoleMessage.MessageType.Warning)
      level = ConsoleModel.ConsoleMessage.MessageLevel.Warning;
    else if (
        call.type === ConsoleModel.ConsoleMessage.MessageType.Info ||
        call.type === ConsoleModel.ConsoleMessage.MessageType.Log)
      level = ConsoleModel.ConsoleMessage.MessageLevel.Info;
    var message = '';
    if (call.args.length && typeof call.args[0].value === 'string')
      message = call.args[0].value;
    else if (call.args.length && call.args[0].description)
      message = call.args[0].description;
    var callFrame = call.stackTrace && call.stackTrace.callFrames.length ? call.stackTrace.callFrames[0] : null;
    var consoleMessage = new ConsoleModel.ConsoleMessage(
        runtimeModel.target(), ConsoleModel.ConsoleMessage.MessageSource.ConsoleAPI, level,
        /** @type {string} */ (message), call.type, callFrame ? callFrame.url : undefined,
        callFrame ? callFrame.lineNumber : undefined, callFrame ? callFrame.columnNumber : undefined, undefined,
        call.args, call.stackTrace, call.timestamp, call.executionContextId, undefined);
    this.addMessage(consoleMessage);
  }

  /**
   * @param {!Common.Event} event
   */
  _mainFrameStartedLoading(event) {
    if (!Common.moduleSetting('preserveConsoleLog').get())
      this._clear();
  }

  /**
   * @param {!Common.Event} event
   */
  _mainFrameNavigated(event) {
    if (Common.moduleSetting('preserveConsoleLog').get())
      Common.console.log(Common.UIString('Navigated to %s', event.data.url));
  }

  /**
   * @param {!SDK.CPUProfilerModel} cpuProfilerModel
   * @param {!Common.Event} event
   */
  _consoleProfileStarted(cpuProfilerModel, event) {
    var data = /** @type {!SDK.CPUProfilerModel.EventData} */ (event.data);
    this._addConsoleProfileMessage(
        cpuProfilerModel, ConsoleModel.ConsoleMessage.MessageType.Profile, data.scriptLocation,
        Common.UIString('Profile \'%s\' started.', data.title));
  }

  /**
   * @param {!SDK.CPUProfilerModel} cpuProfilerModel
   * @param {!Common.Event} event
   */
  _consoleProfileFinished(cpuProfilerModel, event) {
    var data = /** @type {!SDK.CPUProfilerModel.EventData} */ (event.data);
    this._addConsoleProfileMessage(
        cpuProfilerModel, ConsoleModel.ConsoleMessage.MessageType.ProfileEnd, data.scriptLocation,
        Common.UIString('Profile \'%s\' finished.', data.title));
  }

  /**
   * @param {!SDK.CPUProfilerModel} cpuProfilerModel
   * @param {string} type
   * @param {!SDK.DebuggerModel.Location} scriptLocation
   * @param {string} messageText
   */
  _addConsoleProfileMessage(cpuProfilerModel, type, scriptLocation, messageText) {
    var stackTrace = [{
      functionName: '',
      scriptId: scriptLocation.scriptId,
      url: scriptLocation.script() ? scriptLocation.script().contentURL() : '',
      lineNumber: scriptLocation.lineNumber,
      columnNumber: scriptLocation.columnNumber || 0
    }];
    this.addMessage(new ConsoleModel.ConsoleMessage(
        cpuProfilerModel.target(), ConsoleModel.ConsoleMessage.MessageSource.ConsoleAPI,
        ConsoleModel.ConsoleMessage.MessageLevel.Info, messageText, type, undefined, undefined, undefined, undefined,
        stackTrace));
  }

  /**
   * @param {!SDK.NetworkManager} networkManager
   * @param {!Common.Event} event
   */
  _networkWarningGenerated(networkManager, event) {
    var warning = /** @type {!SDK.NetworkManager.Warning} */ (event.data);
    this.addMessage(new ConsoleModel.ConsoleMessage(
        networkManager.target(), ConsoleModel.ConsoleMessage.MessageSource.Network,
        ConsoleModel.ConsoleMessage.MessageLevel.Warning, warning.message, undefined, undefined, undefined, undefined,
        warning.requestId));
  }

  /**
   * @param {!ConsoleModel.ConsoleMessage} msg
   */
  _incrementErrorWarningCount(msg) {
    if (msg.source === ConsoleModel.ConsoleMessage.MessageSource.Violation)
      return;
    switch (msg.level) {
      case ConsoleModel.ConsoleMessage.MessageLevel.Warning:
        this._warnings++;
        break;
      case ConsoleModel.ConsoleMessage.MessageLevel.Error:
        this._errors++;
        break;
    }
  }

  /**
   * @return {!Array.<!ConsoleModel.ConsoleMessage>}
   */
  messages() {
    return this._messages;
  }

  requestClearMessages() {
    for (var logModel of SDK.targetManager.models(SDK.LogModel))
      logModel.requestClear();
    for (var runtimeModel of SDK.targetManager.models(SDK.RuntimeModel))
      runtimeModel.discardConsoleEntries();
    this._clear();
  }

  _clear() {
    this._messages = [];
    this._messageByExceptionId.clear();
    this._errors = 0;
    this._warnings = 0;
    this.dispatchEventToListeners(ConsoleModel.ConsoleModel.Events.ConsoleCleared);
  }

  /**
   * @return {number}
   */
  errors() {
    return this._errors;
  }

  /**
   * @return {number}
   */
  warnings() {
    return this._warnings;
  }
};

/** @enum {symbol} */
ConsoleModel.ConsoleModel.Events = {
  ConsoleCleared: Symbol('ConsoleCleared'),
  MessageAdded: Symbol('MessageAdded'),
  MessageUpdated: Symbol('MessageUpdated'),
  CommandEvaluated: Symbol('CommandEvaluated')
};


/**
 * @unrestricted
 */
ConsoleModel.ConsoleMessage = class {
  /**
   * @param {?SDK.Target} target
   * @param {string} source
   * @param {?string} level
   * @param {string} messageText
   * @param {string=} type
   * @param {?string=} url
   * @param {number=} line
   * @param {number=} column
   * @param {!Protocol.Network.RequestId=} requestId
   * @param {!Array.<!Protocol.Runtime.RemoteObject>=} parameters
   * @param {!Protocol.Runtime.StackTrace=} stackTrace
   * @param {number=} timestamp
   * @param {!Protocol.Runtime.ExecutionContextId=} executionContextId
   * @param {?string=} scriptId
   * @param {?string=} workerId
   */
  constructor(
      target, source, level, messageText, type, url, line, column, requestId, parameters, stackTrace, timestamp,
      executionContextId, scriptId, workerId) {
    this._target = target;
    this.source = source;
    this.level = /** @type {?ConsoleModel.ConsoleMessage.MessageLevel} */ (level);
    this.messageText = messageText;
    this.type = type || ConsoleModel.ConsoleMessage.MessageType.Log;
    /** @type {string|undefined} */
    this.url = url || undefined;
    /** @type {number} */
    this.line = line || 0;
    /** @type {number} */
    this.column = column || 0;
    this.parameters = parameters;
    /** @type {!Protocol.Runtime.StackTrace|undefined} */
    this.stackTrace = stackTrace;
    this.timestamp = timestamp || Date.now();
    this.executionContextId = executionContextId || 0;
    this.scriptId = scriptId || null;
    this.workerId = workerId || null;

    this.request = (target && requestId) ? SDK.networkLog.requestForId(target, requestId) : null;

    if (this.request) {
      var initiator = this.request.initiator();
      if (initiator) {
        this.stackTrace = initiator.stack || undefined;
        if (initiator.url) {
          this.url = initiator.url;
          this.line = initiator.lineNumber || 0;
        }
      }
    }
  }

  /**
   * @param {!ConsoleModel.ConsoleMessage} a
   * @param {!ConsoleModel.ConsoleMessage} b
   * @return {number}
   */
  static timestampComparator(a, b) {
    return a.timestamp - b.timestamp;
  }

  /**
   * @param {!SDK.Target} target
   * @param {!Protocol.Runtime.ExceptionDetails} exceptionDetails
   * @param {string=} messageType
   * @param {number=} timestamp
   * @param {string=} forceUrl
   * @return {!ConsoleModel.ConsoleMessage}
   */
  static fromException(target, exceptionDetails, messageType, timestamp, forceUrl) {
    return new ConsoleModel.ConsoleMessage(
        target, ConsoleModel.ConsoleMessage.MessageSource.JS, ConsoleModel.ConsoleMessage.MessageLevel.Error,
        SDK.RuntimeModel.simpleTextFromException(exceptionDetails), messageType, forceUrl || exceptionDetails.url,
        exceptionDetails.lineNumber, exceptionDetails.columnNumber, undefined,
        exceptionDetails.exception ?
            [SDK.RemoteObject.fromLocalObject(exceptionDetails.text), exceptionDetails.exception] :
            undefined,
        exceptionDetails.stackTrace, timestamp, exceptionDetails.executionContextId, exceptionDetails.scriptId);
  }

  /**
   * @return {?SDK.Target}
   */
  target() {
    return this._target;
  }

  /**
   * @param {!ConsoleModel.ConsoleMessage} originatingMessage
   */
  setOriginatingMessage(originatingMessage) {
    this._originatingConsoleMessage = originatingMessage;
    this.executionContextId = originatingMessage.executionContextId;
  }

  /**
   * @param {!Protocol.Runtime.ExecutionContextId} executionContextId
   */
  setExecutionContextId(executionContextId) {
    this.executionContextId = executionContextId;
  }

  /**
   * @param {number} exceptionId
   */
  setExceptionId(exceptionId) {
    this._exceptionId = exceptionId;
  }

  /**
   * @return {?ConsoleModel.ConsoleMessage}
   */
  originatingMessage() {
    return this._originatingConsoleMessage;
  }

  /**
   * @return {boolean}
   */
  isGroupMessage() {
    return this.type === ConsoleModel.ConsoleMessage.MessageType.StartGroup ||
        this.type === ConsoleModel.ConsoleMessage.MessageType.StartGroupCollapsed ||
        this.type === ConsoleModel.ConsoleMessage.MessageType.EndGroup;
  }

  /**
   * @return {boolean}
   */
  isGroupStartMessage() {
    return this.type === ConsoleModel.ConsoleMessage.MessageType.StartGroup ||
        this.type === ConsoleModel.ConsoleMessage.MessageType.StartGroupCollapsed;
  }

  /**
   * @return {boolean}
   */
  isErrorOrWarning() {
    return (
        this.level === ConsoleModel.ConsoleMessage.MessageLevel.Warning ||
        this.level === ConsoleModel.ConsoleMessage.MessageLevel.Error);
  }

  /**
   * @param {?ConsoleModel.ConsoleMessage} msg
   * @return {boolean}
   */
  isEqual(msg) {
    if (!msg)
      return false;

    if (this._exceptionId || msg._exceptionId)
      return false;

    if (!this._isEqualStackTraces(this.stackTrace, msg.stackTrace))
      return false;

    if (this.parameters) {
      if (!msg.parameters || this.parameters.length !== msg.parameters.length)
        return false;

      for (var i = 0; i < msg.parameters.length; ++i) {
        // Never treat objects as equal - their properties might change over time.
        if (this.parameters[i].type !== msg.parameters[i].type || msg.parameters[i].type === 'object' ||
            this.parameters[i].value !== msg.parameters[i].value)
          return false;
      }
    }

    return (this.target() === msg.target()) && (this.source === msg.source) && (this.type === msg.type) &&
        (this.level === msg.level) && (this.line === msg.line) && (this.url === msg.url) &&
        (this.messageText === msg.messageText) && (this.request === msg.request) &&
        (this.executionContextId === msg.executionContextId);
  }

  /**
   * @param {!Protocol.Runtime.StackTrace|undefined} stackTrace1
   * @param {!Protocol.Runtime.StackTrace|undefined} stackTrace2
   * @return {boolean}
   */
  _isEqualStackTraces(stackTrace1, stackTrace2) {
    if (!stackTrace1 !== !stackTrace2)
      return false;
    if (!stackTrace1)
      return true;
    var callFrames1 = stackTrace1.callFrames;
    var callFrames2 = stackTrace2.callFrames;
    if (callFrames1.length !== callFrames2.length)
      return false;
    for (var i = 0, n = callFrames1.length; i < n; ++i) {
      if (callFrames1[i].url !== callFrames2[i].url || callFrames1[i].functionName !== callFrames2[i].functionName ||
          callFrames1[i].lineNumber !== callFrames2[i].lineNumber ||
          callFrames1[i].columnNumber !== callFrames2[i].columnNumber)
        return false;
    }
    return this._isEqualStackTraces(stackTrace1.parent, stackTrace2.parent);
  }
};

// Note: Keep these constants in sync with the ones in Console.h
/**
 * @enum {string}
 */
ConsoleModel.ConsoleMessage.MessageSource = {
  XML: 'xml',
  JS: 'javascript',
  Network: 'network',
  ConsoleAPI: 'console-api',
  Storage: 'storage',
  AppCache: 'appcache',
  Rendering: 'rendering',
  CSS: 'css',
  Security: 'security',
  Deprecation: 'deprecation',
  Worker: 'worker',
  Violation: 'violation',
  Intervention: 'intervention',
  Other: 'other'
};

/**
 * @enum {string}
 */
ConsoleModel.ConsoleMessage.MessageType = {
  Log: 'log',
  Debug: 'debug',
  Info: 'info',
  Error: 'error',
  Warning: 'warning',
  Dir: 'dir',
  DirXML: 'dirxml',
  Table: 'table',
  Trace: 'trace',
  Clear: 'clear',
  StartGroup: 'startGroup',
  StartGroupCollapsed: 'startGroupCollapsed',
  EndGroup: 'endGroup',
  Assert: 'assert',
  Result: 'result',
  Profile: 'profile',
  ProfileEnd: 'profileEnd',
  Command: 'command'
};

/**
 * @enum {string}
 */
ConsoleModel.ConsoleMessage.MessageLevel = {
  Verbose: 'verbose',
  Info: 'info',
  Warning: 'warning',
  Error: 'error'
};

/**
 * @param {!ConsoleModel.ConsoleMessage.MessageLevel} level
 * @return {number}
 */
ConsoleModel.ConsoleMessage.MessageLevel.ordinal = function(level) {
  if (level === ConsoleModel.ConsoleMessage.MessageLevel.Verbose)
    return 0;
  if (level === ConsoleModel.ConsoleMessage.MessageLevel.Info)
    return 1;
  if (level === ConsoleModel.ConsoleMessage.MessageLevel.Warning)
    return 2;
  return 3;
};

ConsoleModel.ConsoleModel._events = Symbol('ConsoleModel.ConsoleModel.events');

/**
 * @type {!ConsoleModel.ConsoleModel}
 */
ConsoleModel.consoleModel;

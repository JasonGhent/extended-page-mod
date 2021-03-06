/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

module.metadata = {
  "stability": "stable"
};


//const observers = require('sdk/deprecated/observer-service');
var events = require("sdk/system/events");
const unload = require('sdk/system/unload');
const { Loader, validationAttributes } = require('sdk/content/loader');
const { Worker } = require('sdk/content/worker');
const { EventEmitter } = require('sdk/deprecated/events');
const { List } = require('sdk/deprecated/list');
const { MatchPattern } = require('sdk/util/match-pattern');
const { validateOptions : validate } = require('sdk/deprecated/api-utils');
const { Cc, Ci } = require('chrome');
const { merge } = require('sdk/util/object');
const { readURISync } = require('sdk/net/url');
const { windowIterator } = require('sdk/deprecated/window-utils');
const { isBrowser, getFrames } = require('sdk/window/utils');
const { getTabs, getTabContentWindow, getTabForContentWindow,
  getURI: getTabURI } = require('sdk/tabs/utils');
const { has, hasAny } = require('sdk/util/array');
const { ignoreWindow } = require('sdk/private-browsing/utils');

const styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"].
  getService(Ci.nsIStyleSheetService);

const USER_SHEET = styleSheetService.USER_SHEET;

const io = Cc['@mozilla.org/network/io-service;1'].
  getService(Ci.nsIIOService);

// Valid values for `attachTo` option
const VALID_ATTACHTO_OPTIONS = ['existing', 'top', 'frame'];

// contentStyle* / contentScript* are sharing the same validation constraints,
// so they can be mostly reused, except for the messages.
const validStyleOptions = {
  contentStyle: merge(Object.create(validationAttributes.contentScript), {
    msg: 'The `contentStyle` option must be a string or an array of strings.'
  }),
  contentStyleFile: merge(Object.create(validationAttributes.contentScriptFile), {
    msg: 'The `contentStyleFile` option must be a local URL or an array of URLs'
  })
};

// rules registry
const RULES = {};

// ANTI RULES
const EXCLUDE_RULES = {}

const Rules = EventEmitter.resolve({ toString: null }).compose(List, {
    add: function() Array.slice(arguments).forEach(function onAdd(rule) {
      if (this._has(rule))
        return;
      // registering rule to the rules registry
      if (!(rule in RULES))
        RULES[rule] = new MatchPattern(rule);
      this._add(rule);
      this._emit('add', rule);
    }.bind(this)),
  remove: function() Array.slice(arguments).forEach(function onRemove(rule) {
  if (!this._has(rule))
    return;
  this._remove(rule);
  this._emit('remove', rule);
}.bind(this)),
});

/**
 * ExtendedPageMod constructor (exported below).
 * @constructor
 */
const ExtendedPageMod = Loader.compose(EventEmitter, {
  on: EventEmitter.required,
  _listeners: EventEmitter.required,
  attachTo: [],
  contentScript: Loader.required,
  contentScriptFile: Loader.required,
  contentScriptWhen: Loader.required,
  contentScriptOptions: Loader.required,
  excludeURLs: null,
  include: null,
  constructor: function ExtendedPageMod(options) {
    this._onContent = this._onContent.bind(this);
    options = options || {};

    let { contentStyle, contentStyleFile } = validate(options, validStyleOptions);

    if ('contentScript' in options)
      this.contentScript = options.contentScript;
    if ('contentScriptFile' in options)
      this.contentScriptFile = options.contentScriptFile;
    if ('contentScriptOptions' in options)
      this.contentScriptOptions = options.contentScriptOptions;
    if ('contentScriptWhen' in options)
      this.contentScriptWhen = options.contentScriptWhen;
    if ('onAttach' in options)
      this.on('attach', options.onAttach);
    if ('onError' in options)
      this.on('error', options.onError);
    if ('attachTo' in options) {
      if (typeof options.attachTo == 'string')
        this.attachTo = [options.attachTo];
      else if (Array.isArray(options.attachTo))
        this.attachTo = options.attachTo;
      else
        throw new Error('The `attachTo` option must be a string or an array ' +
          'of strings.');

      let isValidAttachToItem = function isValidAttachToItem(item) {
        return typeof item === 'string' &&
          VALID_ATTACHTO_OPTIONS.indexOf(item) !== -1;
      }
      if (!this.attachTo.every(isValidAttachToItem))
        throw new Error('The `attachTo` option valid accept only following ' +
          'values: '+ VALID_ATTACHTO_OPTIONS.join(', '));
      if (!hasAny(this.attachTo, ["top", "frame"]))
        throw new Error('The `attachTo` option must always contain at least' +
          ' `top` or `frame` value');
    }
    else {
      this.attachTo = ["top", "frame"];
    }

    let include = options.include;
    let exclude = options.exclude || [];
    let rules = this.include = Rules();
    rules.on('add', this._onRuleAdd = this._onRuleAdd.bind(this));
    rules.on('remove', this._onRuleRemove = this._onRuleRemove.bind(this));

    // Build exclusion array
    if(Array.isArray(exclude)) {
      this.excludeURLs = [];
      for(let i = 0; i < exclude.length; i++) {
        this.excludeURLs.push(new MatchPattern(exclude[i]));
      }
    } else {
      this.excludeURLs = [new MatchPattern(exclude)];
    }

    if (Array.isArray(include)) {
      rules.add.apply(null, include);
    } else {
      rules.add(include);
    }

    let styleRules = "";

    if (contentStyleFile)
      styleRules = [].concat(contentStyleFile).map(readURISync).join("");

    if (contentStyle)
      styleRules += [].concat(contentStyle).join("");

    if (styleRules) {
      this._onRuleUpdate = this._onRuleUpdate.bind(this);

      this._styleRules = styleRules;

      this._registerStyleSheet();
      rules.on('add', this._onRuleUpdate);
      rules.on('remove', this._onRuleUpdate);
    }

    this.on('error', this._onUncaughtError = this._onUncaughtError.bind(this));
    pageModManager.add(this._public);

    this._loadingWindows = [];

    // `_applyOnExistingDocuments` has to be called after `pageModManager.add()`
    // otherwise its calls to `_onContent` method won't do anything.
    if ('attachTo' in options && has(options.attachTo, 'existing'))
      this._applyOnExistingDocuments();
  },

  destroy: function destroy() {

    this._unregisterStyleSheet();

    this.include.removeListener('add', this._onRuleUpdate);
    this.include.removeListener('remove', this._onRuleUpdate);

    for each (let rule in this.include)
    this.include.remove(rule);
    pageModManager.remove(this._public);
    this._loadingWindows = [];

  },

  _loadingWindows: [],

  _applyOnExistingDocuments: function _applyOnExistingDocuments() {
    let mod = this;
    // Returns true if the tab match one rule
    function isMatchingURI(uri) {
      // Use Array.some as `include` isn't a native array
      return Array.some(mod.include, function (rule) {
        return RULES[rule].test(uri);
      });
    }
    let tabs = getAllTabs().filter(function (tab) {
      return isMatchingURI(getTabURI(tab));
    });

    tabs.forEach(function (tab) {
      // Fake a newly created document
      let window = getTabContentWindow(tab);
      if (has(mod.attachTo, "top"))
        mod._onContent(window);
      if (has(mod.attachTo, "frame"))
        getFrames(window).forEach(mod._onContent);
    });
  },

  _onContent: function _onContent(window) {
    // If page is to be ignored
    var url = window.document.URL;
    for each (let excludeURL in this.excludeURLs) {
      if(excludeURL.test(url)) {
        return;
      }
    }

    // not registered yet
    if (!pageModManager.has(this))
      return;

    let isTopDocument = window.top === window;
    // Is a top level document and `top` is not set, ignore
    if (isTopDocument && !has(this.attachTo, "top"))
      return;
    // Is a frame document and `frame` is not set, ignore
    if (!isTopDocument && !has(this.attachTo, "frame"))
      return;

    // Immediatly evaluate content script if the document state is already
    // matching contentScriptWhen expectations
    let state = window.document.readyState;
    if ('start' === this.contentScriptWhen ||
      // Is `load` event already dispatched?
      'complete' === state ||
      // Is DOMContentLoaded already dispatched and waiting for it?
      ('ready' === this.contentScriptWhen && state === 'interactive') ) {
      this._createWorker(window);
      return;
    }

    let eventName = 'end' == this.contentScriptWhen ? 'load' : 'DOMContentLoaded';
    let self = this;
    window.addEventListener(eventName, function onReady(event) {
      if (event.target.defaultView != window)
        return;
      window.removeEventListener(eventName, onReady, true);

      self._createWorker(window);
    }, true);
  },
  _createWorker: function _createWorker(window) {
    let worker = Worker({
      window: window,
      contentScript: this.contentScript,
      contentScriptFile: this.contentScriptFile,
      contentScriptOptions: this.contentScriptOptions,
      onError: this._onUncaughtError
    });
    this._emit('attach', worker);
    let self = this;
    worker.once('detach', function detach() {
      worker.destroy();
    });
  },
  _onRuleAdd: function _onRuleAdd(url) {
    pageModManager.on(url, this._onContent);
  },
  _onRuleRemove: function _onRuleRemove(url) {
    pageModManager.off(url, this._onContent);
  },
  _onUncaughtError: function _onUncaughtError(e) {
    if (this._listeners('error').length == 1)
      console.exception(e);
  },
  _onRuleUpdate: function _onRuleUpdate(){
    this._registerStyleSheet();
  },

  _registerStyleSheet : function _registerStyleSheet() {
    let rules = this.include;
    let styleRules = this._styleRules;

    let documentRules = [];

    this._unregisterStyleSheet();

    for each (let rule in rules) {
      let pattern = RULES[rule];

      if (!pattern)
        continue;

      if (pattern.regexp)
        documentRules.push("regexp(\"" + pattern.regexp.source + "\")");
      else if (pattern.exactURL)
        documentRules.push("url(" + pattern.exactURL + ")");
      else if (pattern.domain)
        documentRules.push("domain(" + pattern.domain + ")");
      else if (pattern.urlPrefix)
        documentRules.push("url-prefix(" + pattern.urlPrefix + ")");
      else if (pattern.anyWebPage)
        documentRules.push("regexp(\"^(https?|ftp)://.*?\")");
    }

    let uri = "data:text/css;charset=utf-8,";
    if (documentRules.length > 0)
      uri += encodeURIComponent("@-moz-document " +
        documentRules.join(",") + " {" + styleRules + "}");
    else
      uri += encodeURIComponent(styleRules);

    this._registeredStyleURI = io.newURI(uri, null, null);

    styleSheetService.loadAndRegisterSheet(
      this._registeredStyleURI,
      USER_SHEET
    );
  },

  _unregisterStyleSheet : function () {
    let uri = this._registeredStyleURI;

    if (uri  && styleSheetService.sheetRegistered(uri, USER_SHEET))
      styleSheetService.unregisterSheet(uri, USER_SHEET);

    this._registeredStyleURI = null;
  }
});
exports.ExtendedPageMod = function(options) ExtendedPageMod(options)
exports.ExtendedPageMod.prototype = ExtendedPageMod.prototype;

const Registry = EventEmitter.compose({
  _registry: null,
  _constructor: null,
  constructor: function Registry(constructor) {
    this._registry = [];
    this._constructor = constructor;
    this.on('error', this._onError = this._onError.bind(this));
    unload.ensure(this, "_destructor");
  },
  _destructor: function _destructor() {
    let _registry = this._registry.slice(0);
    for (let instance of _registry)
      this._emit('remove', instance);
    this._registry.splice(0);
  },
  _onError: function _onError(e) {
    if (!this._listeners('error').length)
      console.error(e);
  },
  has: function has(instance) {
    let _registry = this._registry;
    return (
      (0 <= _registry.indexOf(instance)) ||
      (instance && instance._public && 0 <= _registry.indexOf(instance._public))
    );
  },
  add: function add(instance) {
    let { _constructor, _registry } = this; 
    if (!(instance instanceof _constructor))
      instance = new _constructor(instance);
    if (0 > _registry.indexOf(instance)) {
      _registry.push(instance);
      this._emit('add', instance);
    }
    return instance;
  },
  remove: function remove(instance) {
    let _registry = this._registry;
    let index = _registry.indexOf(instance)
    if (0 <= index) {
      this._emit('remove', instance);
      _registry.splice(index, 1);
    }
  }
});

const ExtendedPageModManager = Registry.resolve({
  constructor: '_init',
  _destructor: '_registryDestructor'
}).compose({
  constructor: function ExtendedPageModRegistry(constructor) {
    this._init(ExtendedPageMod);
    events.on(
      'document-element-inserted',
      this._onContentWindow = this._onContentWindow.bind(this),
      true
    );
  },
  _destructor: function _destructor() {
    events.off('document-element-inserted', this._onContentWindow);
    this._removeAllListeners();
    for (let rule in RULES) {
      delete RULES[rule];
    }

    // We need to do some cleaning er ExtendedPageMods, like unregistering any
    // `contentStyle*`
    this._registry.forEach(function(pageMod) {
      pageMod.destroy();
    });

    this._registryDestructor();
  },
  _onContentWindow: function _onContentWindow(event) {
    let document = event.subject;
    let window = document.ownerGlobal;
    // XML documents don't have windows, and we don't yet support them.
    if (!window) {
      return;
    }
    // We apply only on documents in tabs of Firefox
    if (!getTabForContentWindow(window)) {
      return;
    }

    // When the tab is private, only addons with 'private-browsing' flag in
    // their package.json can apply content script to private documents
    if (ignoreWindow(window)) {
      return;
    }

    for (let rule in RULES)
      if (RULES[rule].test(document.URL)) {
        // If the content script is already injected we want to just exit
        if (window.__contentScriptInjected) {
          return;
        }
        window.__contentScriptInjected = true;
        this._emit(rule, window);
      }
  },
  off: function off(topic, listener) {
    this.removeListener(topic, listener);
    if (!this._listeners(topic).length)
      delete RULES[topic];
  }
});
const pageModManager = ExtendedPageModManager();

// Returns all tabs on all currently opened windows
function getAllTabs() {
  let tabs = [];
  // Iterate over all chrome windows
  for (let window in windowIterator()) {
    if (!isBrowser(window))
      continue;
    tabs = tabs.concat(getTabs(window));
  }
  return tabs;
}


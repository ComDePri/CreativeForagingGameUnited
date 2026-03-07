// cfg-analytics.js
// Drop-in replacement for rm2.WriteConnection using the CFG AWS AppSync backend.
// Must be loaded after cfg-config.js. Overrides the global `rm2` set by redmetrics.js.
(function () {
  'use strict';

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function graphql(url, apiKey, query, variables) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ query: query, variables: variables }),
    }).then(function (res) {
      return res.json();
    }).then(function (json) {
      if (json.errors) throw new Error(json.errors[0].message);
      return json.data;
    });
  }

  var CREATE_PLAYER = [
    'mutation CreatePlayer($input: CreatePlayerInput!) {',
    '  createPlayer(input: $input) { id }',
    '}',
  ].join('\n');

  var CREATE_SESSION = [
    'mutation CreateSession($input: CreateSessionInput!) {',
    '  createSession(input: $input) { id }',
    '}',
  ].join('\n');

  var CREATE_EVENT = [
    'mutation CreateEvent($input: CreateEventInput!) {',
    '  createEvent(input: $input) { id }',
    '}',
  ].join('\n');

  var UPDATE_SESSION = [
    'mutation UpdateSession($input: UpdateSessionInput!) {',
    '  updateSession(input: $input) { id }',
    '}',
  ].join('\n');

  function getUrlParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function WriteConnection(options) {
    this._sessionMeta = options.session || {};
    // Read gameVersion and gameId from URL params (matching old backend URL format).
    // Falls back to CFG_CONFIG values if not present in URL.
    this._gameVersionId = getUrlParam('gameVersion') || window.CFG_CONFIG.DEFAULT_GAME_VERSION_ID || null;
    this._gameId = getUrlParam('gameId') || window.CFG_CONFIG.GAME_ID || null;
    this._sessionId = null;
    this._connected = false;
    this._eventQueue = [];
  }

  Object.defineProperty(WriteConnection.prototype, 'sessionId', {
    get: function () { return this._sessionId; },
  });

  WriteConnection.prototype.connect = function () {
    var self = this;
    var config = window.CFG_CONFIG;
    var url = config.APPSYNC_URL;
    var apiKey = config.APPSYNC_API_KEY;

    if (self._connected) {
      console.warn('CFG: WriteConnection already connected');
      return Promise.resolve();
    }

    var PLAYER_KEY = 'cfg_player_id';
    var anonymousId = localStorage.getItem(PLAYER_KEY);
    if (!anonymousId) {
      anonymousId = generateUUID();
      localStorage.setItem(PLAYER_KEY, anonymousId);
    }

    var now = new Date().toISOString();

    return graphql(url, apiKey, CREATE_PLAYER, {
      input: {
        anonymousId: anonymousId,
        firstSeenAt: now,
        metadata: JSON.stringify(self._sessionMeta),
      },
    }).then(function (data) {
      var playerId = data.createPlayer.id;
      var sessionInput = {
        playerId: playerId,
        gameId: self._gameId,
        startedAt: now,
        metadata: JSON.stringify(self._sessionMeta),
      };
      if (self._gameVersionId) sessionInput.gameVersionId = self._gameVersionId;
      return graphql(url, apiKey, CREATE_SESSION, { input: sessionInput });
    }).then(function (data) {
      self._sessionId = data.createSession.id;
      self._connected = true;
      // Flush buffered events
      self._eventQueue.forEach(function (e) { self._sendEvent(e); });
      self._eventQueue = [];
    });
  };

  WriteConnection.prototype.postEvent = function (event) {
    if (!this._connected) {
      this._eventQueue.push(event);
      return;
    }
    this._sendEvent(event);
  };

  WriteConnection.prototype._sendEvent = function (event) {
    var config = window.CFG_CONFIG;
    graphql(config.APPSYNC_URL, config.APPSYNC_API_KEY, CREATE_EVENT, {
      input: {
        sessionId: this._sessionId,
        gameId: config.GAME_ID,
        type: event.type,
        occurredAt: new Date().toISOString(),
        data: event.customData != null ? JSON.stringify(event.customData) : null,
      },
    }).catch(function (err) {
      console.error('CFG: failed to post event', err);
    });
  };

  WriteConnection.prototype.updateSession = function (session) {
    if (!this._connected) return Promise.resolve();
    var config = window.CFG_CONFIG;
    return graphql(config.APPSYNC_URL, config.APPSYNC_API_KEY, UPDATE_SESSION, {
      input: {
        id: this._sessionId,
        metadata: JSON.stringify(session),
      },
    });
  };

  // Override the rm2 global set by redmetrics.js
  window.rm2 = { WriteConnection: WriteConnection };
}());

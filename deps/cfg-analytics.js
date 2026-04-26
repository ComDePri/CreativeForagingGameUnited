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
    var urlParams = {};
    new URLSearchParams(window.location.search).forEach(function (value, key) {
      urlParams[key] = value;
    });
    // URL params are the base; explicit session options take precedence.
    this._sessionMeta = Object.assign({}, urlParams, options.session || {});
    // Read gameVersion and gameId from URL params (matching old backend URL format).
    // Falls back to CFG_CONFIG values if not present in URL.
    this._gameVersionId = getUrlParam('gameVersion') || getUrlParam('apiKey') || window.CFG_CONFIG.DEFAULT_GAME_VERSION_ID || null;
    this._gameId = getUrlParam('gameId') || window.CFG_CONFIG.GAME_ID || null;
    this._sessionId = null;
    this._connected = false;
    this._eventQueue = [];
    // batchSize controls how many events are accumulated before sending a single
    // POST request. Default 1 = send every event immediately (original behaviour).
    var rawBatch = parseInt(getUrlParam('batchSize') || '1', 10);
    this._batchSize = (isNaN(rawBatch) || rawBatch < 1) ? 1 : rawBatch;
    this._batchQueue = [];
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
      console.log('CFG: connected, sessionId=' + self._sessionId);
      // Flush buffered events; guard each individually so one bad event can't
      // abort the flush and leave the rest stranded.
      var queued = self._eventQueue;
      self._eventQueue = [];
      queued.forEach(function (e) {
        try { self._stageEvent(e); } catch (err) {
          console.error('CFG: failed to send queued event', err);
        }
      });
      // Mark session ended when the page unloads (tab close, navigation, game over)
      window.addEventListener('beforeunload', function () {
        self._markEnded();
      });
    }).catch(function (err) {
      console.error('CFG: connect failed – events will not be recorded:', err);
    });
  };

  WriteConnection.prototype._markEnded = function () {
    if (!this._sessionId) return;
    // Flush any events still waiting in the batch before closing the session.
    this._flushBatch();
    var config = window.CFG_CONFIG;
    // fetch with keepalive ensures the request completes even during page unload
    fetch(config.APPSYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.APPSYNC_API_KEY },
      body: JSON.stringify({
        query: 'mutation UpdateSession($input: UpdateSessionInput!) { updateSession(input: $input) { id } }',
        variables: { input: { id: this._sessionId, endedAt: new Date().toISOString() } },
      }),
      keepalive: true,
    });
  };

  WriteConnection.prototype.postEvent = function (event) {
    if (!this._connected) {
      this._eventQueue.push(event);
      return;
    }
    this._stageEvent(event);
  };

  // Build the event input object and push it onto the batch queue.
  // Flushes the batch automatically once it reaches _batchSize.
  WriteConnection.prototype._stageEvent = function (event) {
    var dataStr = null;
    if (event.customData != null) {
      try {
        dataStr = JSON.stringify(event.customData);
      } catch (err) {
        console.error('CFG: failed to serialize event data, sending without data:', err);
      }
    }
    this._batchQueue.push({
      sessionId: this._sessionId,
      gameId: this._gameId,
      type: event.type,
      occurredAt: new Date().toISOString(),
      data: dataStr,
    });
    if (this._batchQueue.length >= this._batchSize) {
      this._flushBatch();
    }
  };

  // Send all queued event inputs as a single GraphQL POST and clear the queue.
  // For a single event the existing CREATE_EVENT mutation is used unchanged.
  // For multiple events each gets its own aliased createEvent field so that
  // the entire batch travels in one HTTP request.
  WriteConnection.prototype._flushBatch = function () {
    if (this._batchQueue.length === 0) return;
    var batch = this._batchQueue;
    this._batchQueue = [];
    var config = window.CFG_CONFIG;

    if (batch.length === 1) {
      graphql(config.APPSYNC_URL, config.APPSYNC_API_KEY, CREATE_EVENT, {
        input: batch[0],
      }).catch(function (err) {
        console.error('CFG: failed to post event', err);
      });
      return;
    }

    // Build a multi-alias mutation: each event becomes e0, e1, … eN
    var varDefs = batch.map(function (_, i) {
      return '$input' + i + ': CreateEventInput!';
    }).join(', ');
    var fields = batch.map(function (_, i) {
      return '  e' + i + ': createEvent(input: $input' + i + ') { id }';
    }).join('\n');
    var query = 'mutation BatchCreateEvents(' + varDefs + ') {\n' + fields + '\n}';
    var variables = {};
    batch.forEach(function (input, i) { variables['input' + i] = input; });

    graphql(config.APPSYNC_URL, config.APPSYNC_API_KEY, query, variables).catch(function (err) {
      console.error('CFG: failed to post event batch', err);
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

  var backend = getUrlParam('backend');
  if (backend === 'aws') {
    window.rm2 = { WriteConnection: WriteConnection };
  } else if (backend === 'both') {
    var OriginalWriteConnection = window.rm2.WriteConnection;
    function BothWriteConnection(options) {
      this.rm2Conn = new OriginalWriteConnection(options);
      this.awsConn = new WriteConnection(options);
    }
    Object.defineProperty(BothWriteConnection.prototype, 'sessionId', {
      get: function () { return this.awsConn.sessionId || this.rm2Conn.sessionId; }
    });
    BothWriteConnection.prototype.connect = function() {
      var p1 = this.rm2Conn.connect();
      var p2 = this.awsConn.connect();
      return Promise.all([p1, p2]);
    };
    BothWriteConnection.prototype.postEvent = function(event) {
      this.rm2Conn.postEvent(event);
      this.awsConn.postEvent(event);
    };
    BothWriteConnection.prototype.updateSession = function(session) {
      var p1 = this.rm2Conn.updateSession(session);
      var p2 = this.awsConn.updateSession(session);
      return Promise.all([p1, p2]);
    };
    window.rm2 = { WriteConnection: BothWriteConnection };
  }
}());

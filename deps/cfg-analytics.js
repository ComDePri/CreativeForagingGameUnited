// cfg-analytics.js
// Drop-in replacement for rm2.WriteConnection using the CFG AWS AppSync backend.
// Must be loaded after cfg-config.js and redmetrics.js.
//
// Backend selection (via ?backend= URL param):
//   backend=aws  → write only to the new AWS backend (no old DB).
//   anything else (including rm1/rm2 defaults) → write to BOTH the old DB and
//                  the new AWS backend, and show a migration alert to the user.
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

  WriteConnection.prototype.updatePlayer = function (player) {
    return this.updateSession(player);
  };

  // ── Migration alert overlay ───────────────────────────────────────────────

  function showOldDbAlert() {
    function render() {
      var overlay = document.createElement('div');
      overlay.id = 'cfg-migration-alert';
      overlay.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'width:100%', 'height:100%',
        'background:rgba(0,0,0,0.85)', 'z-index:99999',
        'display:flex', 'align-items:center', 'justify-content:center',
        'font-family:sans-serif',
      ].join(';');

      var box = document.createElement('div');
      box.style.cssText = [
        'background:#fff', 'border-radius:8px', 'padding:32px 40px',
        'max-width:640px', 'width:90%', 'text-align:center',
        'box-shadow:0 4px 32px rgba(0,0,0,0.5)',
      ].join(';');

      var heading = document.createElement('h2');
      heading.textContent = 'Important: CFG Database Migration';
      heading.style.cssText = 'margin:0 0 16px;color:#c0392b;font-size:20px;';

      var msg = document.createElement('p');
      msg.style.cssText = 'font-size:15px;line-height:1.7;margin:0 0 24px;color:#333;text-align:left;';
      msg.textContent = 'The CFG game is now using a new DB (all data was migrated to it). ' +
        'This game currently saves to an old DB alongside the new one, ' +
        'but the old DB will be deleted soon. ' +
        'Please contact comdepri+cfgdbmigrate@mail.huji.ac.il to get access to the new DB ' +
        'so you can make sure all your data is there.';

      var btn = document.createElement('button');
      btn.textContent = 'I understand – continue to game';
      btn.style.cssText = [
        'background:#2980b9', 'color:#fff', 'border:none', 'border-radius:4px',
        'padding:10px 24px', 'font-size:15px', 'cursor:pointer',
      ].join(';');
      btn.onclick = function () {
        document.body.removeChild(overlay);
      };

      box.appendChild(heading);
      box.appendChild(msg);
      box.appendChild(btn);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }

    if (document.body) {
      render();
    } else {
      window.addEventListener('DOMContentLoaded', render);
    }
  }

  // ── Backend selection ─────────────────────────────────────────────────────
  //
  // ?backend=aws  → write only to the new AWS backend. No alert.
  // anything else → write to BOTH the old backend AND the new AWS backend,
  //                 and show the migration alert.

  var backend = getUrlParam('backend');

  if (backend === 'aws') {
    // Only AWS — replace rm2 with the new WriteConnection directly.
    window.rm2 = { WriteConnection: WriteConnection };

  } else {
    // Old backend is in use (rm1 or rm2). Dual-write to both old and AWS,
    // and inform the researcher about the migration.

    // ── Wrap rm2.WriteConnection (rm2 / default path) ──────────────────────
    var OriginalWriteConnection = window.rm2 && window.rm2.WriteConnection;

    function BothWriteConnection(options) {
      this.rm2Conn = OriginalWriteConnection ? new OriginalWriteConnection(options) : null;
      this.awsConn = new WriteConnection(options);
    }

    Object.defineProperty(BothWriteConnection.prototype, 'sessionId', {
      get: function () {
        return this.awsConn.sessionId || (this.rm2Conn && this.rm2Conn.sessionId);
      },
    });

    BothWriteConnection.prototype.connect = function () {
      var p1 = this.rm2Conn ? this.rm2Conn.connect() : Promise.resolve();
      var p2 = this.awsConn.connect();
      return Promise.all([p1, p2]);
    };

    BothWriteConnection.prototype.postEvent = function (event) {
      if (this.rm2Conn) this.rm2Conn.postEvent(event);
      this.awsConn.postEvent(event);
    };

    BothWriteConnection.prototype.updateSession = function (session) {
      var p1 = this.rm2Conn && this.rm2Conn.updateSession
        ? this.rm2Conn.updateSession(session) : Promise.resolve();
      var p2 = this.awsConn.updateSession(session);
      return Promise.all([p1, p2]);
    };

    BothWriteConnection.prototype.updatePlayer = function (player) {
      if (this.rm2Conn && this.rm2Conn.updatePlayer) this.rm2Conn.updatePlayer(player);
      this.awsConn.updateSession(player);
    };

    window.rm2 = { WriteConnection: BothWriteConnection };

    // ── Wrap redmetrics.prepareWriteConnection (rm1 path) ──────────────────
    if (window.redmetrics && typeof window.redmetrics.prepareWriteConnection === 'function') {
      var origPrepare = window.redmetrics.prepareWriteConnection;
      window.redmetrics.prepareWriteConnection = function (config) {
        var rm1Conn = origPrepare(config);
        var awsConn = new WriteConnection({ session: config.player || config });

        return {
          connect: function () {
            return Promise.all([rm1Conn.connect(), awsConn.connect()]);
          },
          postEvent: function (event) {
            rm1Conn.postEvent(event);
            awsConn.postEvent(event);
          },
          updateSession: function (session) {
            if (rm1Conn.updateSession) rm1Conn.updateSession(session);
            awsConn.updateSession(session);
          },
          updatePlayer: function (player) {
            if (rm1Conn.updatePlayer) rm1Conn.updatePlayer(player);
            awsConn.updateSession(player);
          },
          get sessionId() {
            return awsConn.sessionId || rm1Conn.sessionId;
          },
        };
      };
    }

    // Show migration alert.
    showOldDbAlert();
  }
}());

// Uses AMD or browser globals to create a module.

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(["q-xhr"], factory);
    } else {
        // Browser globals
        root.redmetrics = factory(root.b);
    }
}(this, function (b) {
    var redmetrics = {};

    redmetrics.prepareWriteConnection = function(connectionOptions) {
        var eventQueue = [];
        var snapshotQueue = [];
        var postDeferred = Q.defer();
        var timerId = null;
        var connectionPromise = null;

        // This data structure will be returned from the prepareWriteConnection() function
        var writeConnection = {
            connected: false,
            playerId: null,
            playerInfo: {},
            // Get options passed to the factory. Works even if connectionOptions is undefined 
            options: _.defaults({}, connectionOptions, {
                protocol: "https",
                host: "api.redmetrics.io",
                port: 443,
                bufferingDelay: 5000,
                player: {}
            }),
        };

        // Build base URL
        if(!writeConnection.options.baseUrl) {
            writeConnection.options.baseUrl = writeConnection.options.protocol + "://" + writeConnection.options.host + ":" + writeConnection.options.port;
        }

        if(!writeConnection.options.gameVersionId) {
            throw new Error("Missing options.gameVersionId");
        }


        function getUserTime() {
            return new Date().toISOString();
        }

        function sendData() {
            if(eventQueue.length == 0 && snapshotQueue.length == 0) return;

            Q.spread([sendEvents(), sendSnapshots()], function(eventCount, snaphotCount) {
                postDeferred.resolve({
                    events: eventCount,
                    snapshots: snaphotCount
                });
            }).fail(function(error) {
                postDeferred.reject(new Error("Error posting data: " + error));
            }).fin(function() {
                // Create new deferred
                postDeferred = Q.defer();
            });
        }

        function sendEvents() {
            if(eventQueue.length == 0) return Q.fcall(function() { 
                return 0; 
            });

            // Add data related to current connection
            for(var i = 0; i < eventQueue.length; i++) {
                _.extend(eventQueue[i], {
                    gameVersion: writeConnection.options.gameVersionId,
                    player: writeConnection.playerId,
                });
            }

            var request = Q.xhr({
                url: writeConnection.options.baseUrl + "/v1/event/",
                method: "POST",
                data: JSON.stringify(eventQueue),
                contentType: "application/json"
            }).then(function(result) {
               return result.data.length;
            }).fail(function(error) {
                throw new Error("Error posting events: " + error);
            });

            // Clear queue
            eventQueue = [];

            return request;
        }

        function sendSnapshots() {
            if(snapshotQueue.length == 0) return Q.fcall(function() { 
                return 0; 
            });

            // Add data related to current connection
            for(var i = 0; i < snapshotQueue.length; i++) {
                _.extend(snapshotQueue[i], {
                    gameVersion: writeConnection.options.gameVersionId,
                    player: writeConnection.playerId,
                });
            }

            var request = Q.xhr({
                url: writeConnection.options.baseUrl + "/v1/snapshot/",
                method: "POST",
                data: JSON.stringify(snapshotQueue),
                contentType: "application/json"
            }).then(function(result) {
                return result.data.length;
            }).fail(function(error) {
                throw new Error("Error posting snapshots: " + error);
            });

            // Clear queue
            snapshotQueue = [];

            return request;
        }

        writeConnection.connect = function() {
            if(writeConnection.connected) throw new Error("writeConnection is already connected. Call writeConnection.disconnect() before connecting again.");

            _.extend(writeConnection.options.player, writeConnection.playerInfo);

            // The player info may change during the connection process, so hold onto it
            var oldPlayerInfo = writeConnection.playerInfo;

            function getStatus() {
                return Q.xhr.get(writeConnection.options.baseUrl + "/status").fail(function(error) {
                    writeConnection.connected = false;
                    throw new Error("Cannot connect to writeConnection server", writeConnection.options.baseUrl);
                });
            }

            function checkGameVersion() {
                return Q.xhr.get(writeConnection.options.baseUrl + "/v1/gameVersion/" + writeConnection.options.gameVersionId).fail(function(error) {
                    writeConnection.connected = false;
                    throw new Error("Invalid gameVersionId");
                });
            }

            function createPlayer() {
                var playerInfo = writeConnection.options.player;

                // Currently redmetrics requires customData to be encoded as a string
                if(_.has(playerInfo, "customData")) {
                    // Clone object to avoid modifying writeConnection.playerInfo
                    playerInfo = _.clone(playerInfo);
                    playerInfo.customData = JSON.stringify(playerInfo.customData);
                }

                return Q.xhr({
                    url: writeConnection.options.baseUrl + "/v1/player/",
                    method: "POST",
                    data: JSON.stringify(playerInfo),
                    contentType: "application/json"
                }).then(function(result) {
                    writeConnection.playerId = result.data.id;
                }).fail(function(error) {
                    writeConnection.connected = false;
                    throw new Error("Cannot create player: " + error);
                });
            }

            function establishConnection() {
                writeConnection.connected = true;

                // Start sending events
                timerId = window.setInterval(sendData, writeConnection.options.bufferingDelay);

                // If the playerInfo has been modified during the connection process, call updatePlayer()
                if(oldPlayerInfo != writeConnection.playerInfo) return writeConnection.updatePlayer(writeConnection.playerInfo);
            }   

            // Hold on to connection promise so that other functions may listen to it
            connectionPromise = getStatus().then(checkGameVersion).then(createPlayer).then(establishConnection);
            return connectionPromise;
        };

        writeConnection.disconnect = function() {
            function resetState() {
                writeConnection.playerId = null;
                connectionPromise = null;

                writeConnection.connected = false;
            }

            // Stop timer
            if(timerId) {
                window.clearInterval(timerId);
                timerId = null;
            }

            if(connectionPromise) {
                // Flush any remaining data
                return connectionPromise.then(sendData).fin(resetState);
            } else {
                return Q.fcall(resetState);
            }
        };

        writeConnection.postEvent = function(event) {
            if(event.section && _.isArray(event.section)) {
                event.section = event.section.join(".");
            }

            eventQueue.push(_.extend(event, {
                userTime: getUserTime()
            }));

            return postDeferred.promise;
        };

        writeConnection.postSnapshot = function(snapshot) {
            if(snapshot.section && _.isArray(snapshot.section)) {
                snapshot.section = snapshot.section.join(".");
            }

            snapshotQueue.push(_.extend(snapshot, {
                userTime: getUserTime()
            }));

            return postDeferred.promise;
        };

        writeConnection.updatePlayer = function(playerInfo) {
            writeConnection.playerInfo = playerInfo;

            // If we're not yet connected, return immediately
            if(!writeConnection.connected) return Q(writeConnection.playerInfo); 

            // Currently redmetrics requires customData to be encoded as a string
            if(_.has(playerInfo, "customData")) {
                // Clone object to avoid modifying writeConnection.playerInfo
                playerInfo = _.clone(playerInfo);
                playerInfo.customData = JSON.stringify(playerInfo.customData);
            }

            // Otherwise update on the server
            return Q.xhr({
                url: writeConnection.options.baseUrl + "/v1/player/" + writeConnection.playerId,
                method: "PUT",
                data: JSON.stringify(playerInfo),
                contentType: "application/json"
            }).then(function() {
                return writeConnection.playerInfo;
            }).fail(function(error) {
                throw new Error("Cannot update player:", error)
            });
        }

        return writeConnection;
    }

    function formatDateAsIso(dateString) {
        if(!dateString) return null;

        // Read as local date but convert to UTC time
        var localDate = new Date(dateString);
        var utcDate = Date.UTC(localDate.getFullYear(), localDate.getMonth(), 
            localDate.getDate(), localDate.getHours(), localDate.getMinutes(), 
            localDate.getSeconds(), localDate.getMilliseconds());
        return new Date(utcDate).toISOString();
    }

    function readDateAsIso(dateString) {
        if(!dateString) return null;

        // Read as utc date but pretend it is a local date
        var localDate = new Date(dateString);
        return new Date(localDate.getUTCFullYear(), localDate.getUTCMonth(), 
            localDate.getUTCDate(), localDate.getUTCHours(), localDate.getUTCMinutes(), 
            localDate.getUTCSeconds(), localDate.getUTCMilliseconds());
    }

    /*  The _connectionOptions_ object contains:
            * Either _baseUrl_ (like "https://api.redmetrics.api" or the following 
                *   protocol
                *   host
                *   port
            * gameVersionId
        The _searchFilter_ object contains:
            * game
            * gameVersion
            * playerId
            * entityType ("event" or "snapshot")
            * type
            * section
            * before
            * after
            * beforeUserTime
            * afterUserTime
            * page
            * perPage
    */
    redmetrics.executeQuery = function(searchFilter, connectionOptions) {
        _.defaults({}, connectionOptions, {
            protocol: "https",
            host: "api.writeConnection.io",
            port: 443
        });

        // Build base URL
        if(!connectionOptions.baseUrl) {
            connectionOptions.baseUrl = connectionOptions.protocol + "://" + connectionOptions.host + ":" + connectionOptions.port;
        }

        if(!searchFilter.entityType) {
            throw new Error("Missing entityType");
        }

        // Copy over searchFilter
        var newSearchFilter = _.clone(searchFilter);

        // Convert date search filters 
        var dateFilterParams = ["after", "before", "beforeUserTime", "afterUserTime"];
        _.each(dateFilterParams, function(param) {
            if(_.has(searchFilter, param)) {
                newSearchFilter[param] = formatDateAsIso(searchFilter[param]);
            }
        });

        // Make request
        return Q.xhr.get(connectionOptions.baseUrl + "/v1/" + newSearchFilter.entityType, { params: newSearchFilter })
        .then(function(response) {
            var headers = response.headers();
            var result = {
                // Extract page info from headers
                pageNumber: parseInt(headers["x-page-number"]),
                pageCount: parseInt(headers["x-page-count"]),
                perPageCount: parseInt(headers["x-per-page-count"]),
                totalCount: parseInt(headers["x-total-count"]),

                // Copy over original options
                connectionOptions: connectionOptions,
                searchFilter: searchFilter,

                // Convert times in the data
                data: _.each(response.data, function(entity) {
                    entity.serverTime = readDateAsIso(entity.serverTime);
                    if(entity.userTime) {
                        entity.userTime = readDateAsIso(entity.userTime);
                    }
                }),

                // Add helper alias functions
                hasNextPage: function() { return redmetrics.hasNextPage(result); },
                hasPreviousPage: function() { return redmetrics.hasPreviousPage(result); },
                nextPage: function() { return redmetrics.nextPage(result); },
                previousPage: function() { return redmetrics.previousPage(result); },
            };
            return result;
        });
    }

    redmetrics.hasNextPage = function(queryResult) {
        return queryResult.pageNumber < queryResult.pageCount;
    }

    redmetrics.hasPreviousPage = function(queryResult) {
        return queryResult.pageNumber > 1;
    }

    redmetrics.nextPage = function(queryResult) {
        var newSearchFilter = _.extend({}, queryResult.searchFilter, {
            page: queryResult.pageNumber + 1
        });
        return redmetrics.executeQuery(newSearchFilter, queryResult.connectionOptions);
    }

    redmetrics.previousPage = function(queryResult) {
        if(!redmetrics.hasPreviousPage(queryResult)) throw new Error("There is no previous page");

        var newSearchFilter = _.extend({}, queryResult.searchFilter, {
            page: queryResult.pageNumber - 1
        });
        return redmetrics.executeQuery(newSearchFilter, queryResult.connectionOptions);
    }

    return redmetrics;
}));

var rm2 = (() => {
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __defProps = Object.defineProperties;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getOwnPropSymbols = Object.getOwnPropertySymbols;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __propIsEnum = Object.prototype.propertyIsEnumerable;
    var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
    var __spreadValues = (a, b) => {
        for (var prop in b || (b = {}))
            if (__hasOwnProp.call(b, prop))
                __defNormalProp(a, prop, b[prop]);
        if (__getOwnPropSymbols)
            for (var prop of __getOwnPropSymbols(b)) {
                if (__propIsEnum.call(b, prop))
                    __defNormalProp(a, prop, b[prop]);
            }
        return a;
    };
    var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
    var __markAsModule = (target) => __defProp(target, "__esModule", { value: true });
    var __commonJS = (cb, mod) => function __require() {
        return mod || (0, cb[Object.keys(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    };
    var __export = (target, all) => {
        __markAsModule(target);
        for (var name in all)
            __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __reExport = (target, module, desc) => {
        if (module && typeof module === "object" || typeof module === "function") {
            for (let key of __getOwnPropNames(module))
                if (!__hasOwnProp.call(target, key) && key !== "default")
                    __defProp(target, key, { get: () => module[key], enumerable: !(desc = __getOwnPropDesc(module, key)) || desc.enumerable });
        }
        return target;
    };
    var __toModule = (module) => {
        return __reExport(__markAsModule(__defProp(module != null ? __create(__getProtoOf(module)) : {}, "default", module && module.__esModule && "default" in module ? { get: () => module.default, enumerable: true } : { value: module, enumerable: true })), module);
    };

    // node_modules/rm2-typings/dist/types/tables.js
    var require_tables = __commonJS({
        "node_modules/rm2-typings/dist/types/tables.js"(exports) {
            "use strict";
            Object.defineProperty(exports, "__esModule", { value: true });
        }
    });

    // node_modules/rm2-typings/dist/types/routes.js
    var require_routes = __commonJS({
        "node_modules/rm2-typings/dist/types/routes.js"(exports) {
            "use strict";
            Object.defineProperty(exports, "__esModule", { value: true });
        }
    });

    // node_modules/rm2-typings/dist/types/api.js
    var require_api = __commonJS({
        "node_modules/rm2-typings/dist/types/api.js"(exports) {
            "use strict";
            var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
                if (k2 === void 0)
                    k2 = k;
                Object.defineProperty(o, k2, { enumerable: true, get: function() {
                        return m[k];
                    } });
            } : function(o, m, k, k2) {
                if (k2 === void 0)
                    k2 = k;
                o[k2] = m[k];
            });
            var __exportStar = exports && exports.__exportStar || function(m, exports2) {
                for (var p in m)
                    if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p))
                        __createBinding(exports2, m, p);
            };
            Object.defineProperty(exports, "__esModule", { value: true });
            __exportStar(require_routes(), exports);
        }
    });

    // node_modules/rm2-typings/dist/types/full.js
    var require_full = __commonJS({
        "node_modules/rm2-typings/dist/types/full.js"(exports) {
            "use strict";
            Object.defineProperty(exports, "__esModule", { value: true });
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/bind.js
    var require_bind = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/bind.js"(exports, module) {
            "use strict";
            module.exports = function bind(fn, thisArg) {
                return function wrap() {
                    var args = new Array(arguments.length);
                    for (var i = 0; i < args.length; i++) {
                        args[i] = arguments[i];
                    }
                    return fn.apply(thisArg, args);
                };
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/utils.js
    var require_utils = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/utils.js"(exports, module) {
            "use strict";
            var bind = require_bind();
            var toString = Object.prototype.toString;
            function isArray(val) {
                return toString.call(val) === "[object Array]";
            }
            function isUndefined(val) {
                return typeof val === "undefined";
            }
            function isBuffer(val) {
                return val !== null && !isUndefined(val) && val.constructor !== null && !isUndefined(val.constructor) && typeof val.constructor.isBuffer === "function" && val.constructor.isBuffer(val);
            }
            function isArrayBuffer(val) {
                return toString.call(val) === "[object ArrayBuffer]";
            }
            function isFormData(val) {
                return typeof FormData !== "undefined" && val instanceof FormData;
            }
            function isArrayBufferView(val) {
                var result;
                if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView) {
                    result = ArrayBuffer.isView(val);
                } else {
                    result = val && val.buffer && val.buffer instanceof ArrayBuffer;
                }
                return result;
            }
            function isString(val) {
                return typeof val === "string";
            }
            function isNumber(val) {
                return typeof val === "number";
            }
            function isObject(val) {
                return val !== null && typeof val === "object";
            }
            function isPlainObject(val) {
                if (toString.call(val) !== "[object Object]") {
                    return false;
                }
                var prototype = Object.getPrototypeOf(val);
                return prototype === null || prototype === Object.prototype;
            }
            function isDate(val) {
                return toString.call(val) === "[object Date]";
            }
            function isFile(val) {
                return toString.call(val) === "[object File]";
            }
            function isBlob(val) {
                return toString.call(val) === "[object Blob]";
            }
            function isFunction(val) {
                return toString.call(val) === "[object Function]";
            }
            function isStream(val) {
                return isObject(val) && isFunction(val.pipe);
            }
            function isURLSearchParams(val) {
                return typeof URLSearchParams !== "undefined" && val instanceof URLSearchParams;
            }
            function trim(str) {
                return str.trim ? str.trim() : str.replace(/^\s+|\s+$/g, "");
            }
            function isStandardBrowserEnv() {
                if (typeof navigator !== "undefined" && (navigator.product === "ReactNative" || navigator.product === "NativeScript" || navigator.product === "NS")) {
                    return false;
                }
                return typeof window !== "undefined" && typeof document !== "undefined";
            }
            function forEach(obj, fn) {
                if (obj === null || typeof obj === "undefined") {
                    return;
                }
                if (typeof obj !== "object") {
                    obj = [obj];
                }
                if (isArray(obj)) {
                    for (var i = 0, l = obj.length; i < l; i++) {
                        fn.call(null, obj[i], i, obj);
                    }
                } else {
                    for (var key in obj) {
                        if (Object.prototype.hasOwnProperty.call(obj, key)) {
                            fn.call(null, obj[key], key, obj);
                        }
                    }
                }
            }
            function merge() {
                var result = {};
                function assignValue(val, key) {
                    if (isPlainObject(result[key]) && isPlainObject(val)) {
                        result[key] = merge(result[key], val);
                    } else if (isPlainObject(val)) {
                        result[key] = merge({}, val);
                    } else if (isArray(val)) {
                        result[key] = val.slice();
                    } else {
                        result[key] = val;
                    }
                }
                for (var i = 0, l = arguments.length; i < l; i++) {
                    forEach(arguments[i], assignValue);
                }
                return result;
            }
            function extend(a, b, thisArg) {
                forEach(b, function assignValue(val, key) {
                    if (thisArg && typeof val === "function") {
                        a[key] = bind(val, thisArg);
                    } else {
                        a[key] = val;
                    }
                });
                return a;
            }
            function stripBOM(content) {
                if (content.charCodeAt(0) === 65279) {
                    content = content.slice(1);
                }
                return content;
            }
            module.exports = {
                isArray,
                isArrayBuffer,
                isBuffer,
                isFormData,
                isArrayBufferView,
                isString,
                isNumber,
                isObject,
                isPlainObject,
                isUndefined,
                isDate,
                isFile,
                isBlob,
                isFunction,
                isStream,
                isURLSearchParams,
                isStandardBrowserEnv,
                forEach,
                merge,
                extend,
                trim,
                stripBOM
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/buildURL.js
    var require_buildURL = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/buildURL.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            function encode(val) {
                return encodeURIComponent(val).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+").replace(/%5B/gi, "[").replace(/%5D/gi, "]");
            }
            module.exports = function buildURL(url, params, paramsSerializer) {
                if (!params) {
                    return url;
                }
                var serializedParams;
                if (paramsSerializer) {
                    serializedParams = paramsSerializer(params);
                } else if (utils2.isURLSearchParams(params)) {
                    serializedParams = params.toString();
                } else {
                    var parts = [];
                    utils2.forEach(params, function serialize(val, key) {
                        if (val === null || typeof val === "undefined") {
                            return;
                        }
                        if (utils2.isArray(val)) {
                            key = key + "[]";
                        } else {
                            val = [val];
                        }
                        utils2.forEach(val, function parseValue(v) {
                            if (utils2.isDate(v)) {
                                v = v.toISOString();
                            } else if (utils2.isObject(v)) {
                                v = JSON.stringify(v);
                            }
                            parts.push(encode(key) + "=" + encode(v));
                        });
                    });
                    serializedParams = parts.join("&");
                }
                if (serializedParams) {
                    var hashmarkIndex = url.indexOf("#");
                    if (hashmarkIndex !== -1) {
                        url = url.slice(0, hashmarkIndex);
                    }
                    url += (url.indexOf("?") === -1 ? "?" : "&") + serializedParams;
                }
                return url;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/InterceptorManager.js
    var require_InterceptorManager = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/InterceptorManager.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            function InterceptorManager() {
                this.handlers = [];
            }
            InterceptorManager.prototype.use = function use(fulfilled, rejected, options) {
                this.handlers.push({
                    fulfilled,
                    rejected,
                    synchronous: options ? options.synchronous : false,
                    runWhen: options ? options.runWhen : null
                });
                return this.handlers.length - 1;
            };
            InterceptorManager.prototype.eject = function eject(id) {
                if (this.handlers[id]) {
                    this.handlers[id] = null;
                }
            };
            InterceptorManager.prototype.forEach = function forEach(fn) {
                utils2.forEach(this.handlers, function forEachHandler(h) {
                    if (h !== null) {
                        fn(h);
                    }
                });
            };
            module.exports = InterceptorManager;
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/normalizeHeaderName.js
    var require_normalizeHeaderName = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/normalizeHeaderName.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            module.exports = function normalizeHeaderName(headers, normalizedName) {
                utils2.forEach(headers, function processHeader(value, name) {
                    if (name !== normalizedName && name.toUpperCase() === normalizedName.toUpperCase()) {
                        headers[normalizedName] = value;
                        delete headers[name];
                    }
                });
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/enhanceError.js
    var require_enhanceError = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/enhanceError.js"(exports, module) {
            "use strict";
            module.exports = function enhanceError(error, config, code, request, response) {
                error.config = config;
                if (code) {
                    error.code = code;
                }
                error.request = request;
                error.response = response;
                error.isAxiosError = true;
                error.toJSON = function toJSON() {
                    return {
                        message: this.message,
                        name: this.name,
                        description: this.description,
                        number: this.number,
                        fileName: this.fileName,
                        lineNumber: this.lineNumber,
                        columnNumber: this.columnNumber,
                        stack: this.stack,
                        config: this.config,
                        code: this.code,
                        status: this.response && this.response.status ? this.response.status : null
                    };
                };
                return error;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/createError.js
    var require_createError = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/createError.js"(exports, module) {
            "use strict";
            var enhanceError = require_enhanceError();
            module.exports = function createError(message, config, code, request, response) {
                var error = new Error(message);
                return enhanceError(error, config, code, request, response);
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/settle.js
    var require_settle = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/settle.js"(exports, module) {
            "use strict";
            var createError = require_createError();
            module.exports = function settle(resolve, reject, response) {
                var validateStatus = response.config.validateStatus;
                if (!response.status || !validateStatus || validateStatus(response.status)) {
                    resolve(response);
                } else {
                    reject(createError("Request failed with status code " + response.status, response.config, null, response.request, response));
                }
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/cookies.js
    var require_cookies = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/cookies.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            module.exports = utils2.isStandardBrowserEnv() ? function standardBrowserEnv() {
                return {
                    write: function write(name, value, expires, path, domain, secure) {
                        var cookie = [];
                        cookie.push(name + "=" + encodeURIComponent(value));
                        if (utils2.isNumber(expires)) {
                            cookie.push("expires=" + new Date(expires).toGMTString());
                        }
                        if (utils2.isString(path)) {
                            cookie.push("path=" + path);
                        }
                        if (utils2.isString(domain)) {
                            cookie.push("domain=" + domain);
                        }
                        if (secure === true) {
                            cookie.push("secure");
                        }
                        document.cookie = cookie.join("; ");
                    },
                    read: function read(name) {
                        var match = document.cookie.match(new RegExp("(^|;\\s*)(" + name + ")=([^;]*)"));
                        return match ? decodeURIComponent(match[3]) : null;
                    },
                    remove: function remove(name) {
                        this.write(name, "", Date.now() - 864e5);
                    }
                };
            }() : function nonStandardBrowserEnv() {
                return {
                    write: function write() {
                    },
                    read: function read() {
                        return null;
                    },
                    remove: function remove() {
                    }
                };
            }();
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/isAbsoluteURL.js
    var require_isAbsoluteURL = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/isAbsoluteURL.js"(exports, module) {
            "use strict";
            module.exports = function isAbsoluteURL(url) {
                return /^([a-z][a-z\d\+\-\.]*:)?\/\//i.test(url);
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/combineURLs.js
    var require_combineURLs = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/combineURLs.js"(exports, module) {
            "use strict";
            module.exports = function combineURLs(baseURL, relativeURL) {
                return relativeURL ? baseURL.replace(/\/+$/, "") + "/" + relativeURL.replace(/^\/+/, "") : baseURL;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/buildFullPath.js
    var require_buildFullPath = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/buildFullPath.js"(exports, module) {
            "use strict";
            var isAbsoluteURL = require_isAbsoluteURL();
            var combineURLs = require_combineURLs();
            module.exports = function buildFullPath(baseURL, requestedURL) {
                if (baseURL && !isAbsoluteURL(requestedURL)) {
                    return combineURLs(baseURL, requestedURL);
                }
                return requestedURL;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/parseHeaders.js
    var require_parseHeaders = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/parseHeaders.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            var ignoreDuplicateOf = [
                "age",
                "authorization",
                "content-length",
                "content-type",
                "etag",
                "expires",
                "from",
                "host",
                "if-modified-since",
                "if-unmodified-since",
                "last-modified",
                "location",
                "max-forwards",
                "proxy-authorization",
                "referer",
                "retry-after",
                "user-agent"
            ];
            module.exports = function parseHeaders(headers) {
                var parsed = {};
                var key;
                var val;
                var i;
                if (!headers) {
                    return parsed;
                }
                utils2.forEach(headers.split("\n"), function parser(line) {
                    i = line.indexOf(":");
                    key = utils2.trim(line.substr(0, i)).toLowerCase();
                    val = utils2.trim(line.substr(i + 1));
                    if (key) {
                        if (parsed[key] && ignoreDuplicateOf.indexOf(key) >= 0) {
                            return;
                        }
                        if (key === "set-cookie") {
                            parsed[key] = (parsed[key] ? parsed[key] : []).concat([val]);
                        } else {
                            parsed[key] = parsed[key] ? parsed[key] + ", " + val : val;
                        }
                    }
                });
                return parsed;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/isURLSameOrigin.js
    var require_isURLSameOrigin = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/isURLSameOrigin.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            module.exports = utils2.isStandardBrowserEnv() ? function standardBrowserEnv() {
                var msie = /(msie|trident)/i.test(navigator.userAgent);
                var urlParsingNode = document.createElement("a");
                var originURL;
                function resolveURL(url) {
                    var href = url;
                    if (msie) {
                        urlParsingNode.setAttribute("href", href);
                        href = urlParsingNode.href;
                    }
                    urlParsingNode.setAttribute("href", href);
                    return {
                        href: urlParsingNode.href,
                        protocol: urlParsingNode.protocol ? urlParsingNode.protocol.replace(/:$/, "") : "",
                        host: urlParsingNode.host,
                        search: urlParsingNode.search ? urlParsingNode.search.replace(/^\?/, "") : "",
                        hash: urlParsingNode.hash ? urlParsingNode.hash.replace(/^#/, "") : "",
                        hostname: urlParsingNode.hostname,
                        port: urlParsingNode.port,
                        pathname: urlParsingNode.pathname.charAt(0) === "/" ? urlParsingNode.pathname : "/" + urlParsingNode.pathname
                    };
                }
                originURL = resolveURL(window.location.href);
                return function isURLSameOrigin(requestURL) {
                    var parsed = utils2.isString(requestURL) ? resolveURL(requestURL) : requestURL;
                    return parsed.protocol === originURL.protocol && parsed.host === originURL.host;
                };
            }() : function nonStandardBrowserEnv() {
                return function isURLSameOrigin() {
                    return true;
                };
            }();
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/cancel/Cancel.js
    var require_Cancel = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/cancel/Cancel.js"(exports, module) {
            "use strict";
            function Cancel(message) {
                this.message = message;
            }
            Cancel.prototype.toString = function toString() {
                return "Cancel" + (this.message ? ": " + this.message : "");
            };
            Cancel.prototype.__CANCEL__ = true;
            module.exports = Cancel;
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/adapters/xhr.js
    var require_xhr = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/adapters/xhr.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            var settle = require_settle();
            var cookies = require_cookies();
            var buildURL = require_buildURL();
            var buildFullPath = require_buildFullPath();
            var parseHeaders = require_parseHeaders();
            var isURLSameOrigin = require_isURLSameOrigin();
            var createError = require_createError();
            var defaults = require_defaults();
            var Cancel = require_Cancel();
            module.exports = function xhrAdapter(config) {
                return new Promise(function dispatchXhrRequest(resolve, reject) {
                    var requestData = config.data;
                    var requestHeaders = config.headers;
                    var responseType = config.responseType;
                    var onCanceled;
                    function done() {
                        if (config.cancelToken) {
                            config.cancelToken.unsubscribe(onCanceled);
                        }
                        if (config.signal) {
                            config.signal.removeEventListener("abort", onCanceled);
                        }
                    }
                    if (utils2.isFormData(requestData)) {
                        delete requestHeaders["Content-Type"];
                    }
                    var request = new XMLHttpRequest();
                    if (config.auth) {
                        var username = config.auth.username || "";
                        var password = config.auth.password ? unescape(encodeURIComponent(config.auth.password)) : "";
                        requestHeaders.Authorization = "Basic " + btoa(username + ":" + password);
                    }
                    var fullPath = buildFullPath(config.baseURL, config.url);
                    request.open(config.method.toUpperCase(), buildURL(fullPath, config.params, config.paramsSerializer), true);
                    request.timeout = config.timeout;
                    function onloadend() {
                        if (!request) {
                            return;
                        }
                        var responseHeaders = "getAllResponseHeaders" in request ? parseHeaders(request.getAllResponseHeaders()) : null;
                        var responseData = !responseType || responseType === "text" || responseType === "json" ? request.responseText : request.response;
                        var response = {
                            data: responseData,
                            status: request.status,
                            statusText: request.statusText,
                            headers: responseHeaders,
                            config,
                            request
                        };
                        settle(function _resolve(value) {
                            resolve(value);
                            done();
                        }, function _reject(err) {
                            reject(err);
                            done();
                        }, response);
                        request = null;
                    }
                    if ("onloadend" in request) {
                        request.onloadend = onloadend;
                    } else {
                        request.onreadystatechange = function handleLoad() {
                            if (!request || request.readyState !== 4) {
                                return;
                            }
                            if (request.status === 0 && !(request.responseURL && request.responseURL.indexOf("file:") === 0)) {
                                return;
                            }
                            setTimeout(onloadend);
                        };
                    }
                    request.onabort = function handleAbort() {
                        if (!request) {
                            return;
                        }
                        reject(createError("Request aborted", config, "ECONNABORTED", request));
                        request = null;
                    };
                    request.onerror = function handleError() {
                        reject(createError("Network Error", config, null, request));
                        request = null;
                    };
                    request.ontimeout = function handleTimeout() {
                        var timeoutErrorMessage = config.timeout ? "timeout of " + config.timeout + "ms exceeded" : "timeout exceeded";
                        var transitional = config.transitional || defaults.transitional;
                        if (config.timeoutErrorMessage) {
                            timeoutErrorMessage = config.timeoutErrorMessage;
                        }
                        reject(createError(timeoutErrorMessage, config, transitional.clarifyTimeoutError ? "ETIMEDOUT" : "ECONNABORTED", request));
                        request = null;
                    };
                    if (utils2.isStandardBrowserEnv()) {
                        var xsrfValue = (config.withCredentials || isURLSameOrigin(fullPath)) && config.xsrfCookieName ? cookies.read(config.xsrfCookieName) : void 0;
                        if (xsrfValue) {
                            requestHeaders[config.xsrfHeaderName] = xsrfValue;
                        }
                    }
                    if ("setRequestHeader" in request) {
                        utils2.forEach(requestHeaders, function setRequestHeader(val, key) {
                            if (typeof requestData === "undefined" && key.toLowerCase() === "content-type") {
                                delete requestHeaders[key];
                            } else {
                                request.setRequestHeader(key, val);
                            }
                        });
                    }
                    if (!utils2.isUndefined(config.withCredentials)) {
                        request.withCredentials = !!config.withCredentials;
                    }
                    if (responseType && responseType !== "json") {
                        request.responseType = config.responseType;
                    }
                    if (typeof config.onDownloadProgress === "function") {
                        request.addEventListener("progress", config.onDownloadProgress);
                    }
                    if (typeof config.onUploadProgress === "function" && request.upload) {
                        request.upload.addEventListener("progress", config.onUploadProgress);
                    }
                    if (config.cancelToken || config.signal) {
                        onCanceled = function(cancel) {
                            if (!request) {
                                return;
                            }
                            reject(!cancel || cancel && cancel.type ? new Cancel("canceled") : cancel);
                            request.abort();
                            request = null;
                        };
                        config.cancelToken && config.cancelToken.subscribe(onCanceled);
                        if (config.signal) {
                            config.signal.aborted ? onCanceled() : config.signal.addEventListener("abort", onCanceled);
                        }
                    }
                    if (!requestData) {
                        requestData = null;
                    }
                    request.send(requestData);
                });
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/defaults.js
    var require_defaults = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/defaults.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            var normalizeHeaderName = require_normalizeHeaderName();
            var enhanceError = require_enhanceError();
            var DEFAULT_CONTENT_TYPE = {
                "Content-Type": "application/x-www-form-urlencoded"
            };
            function setContentTypeIfUnset(headers, value) {
                if (!utils2.isUndefined(headers) && utils2.isUndefined(headers["Content-Type"])) {
                    headers["Content-Type"] = value;
                }
            }
            function getDefaultAdapter() {
                var adapter;
                if (typeof XMLHttpRequest !== "undefined") {
                    adapter = require_xhr();
                } else if (typeof process !== "undefined" && Object.prototype.toString.call(process) === "[object process]") {
                    adapter = require_xhr();
                }
                return adapter;
            }
            function stringifySafely(rawValue, parser, encoder) {
                if (utils2.isString(rawValue)) {
                    try {
                        (parser || JSON.parse)(rawValue);
                        return utils2.trim(rawValue);
                    } catch (e) {
                        if (e.name !== "SyntaxError") {
                            throw e;
                        }
                    }
                }
                return (encoder || JSON.stringify)(rawValue);
            }
            var defaults = {
                transitional: {
                    silentJSONParsing: true,
                    forcedJSONParsing: true,
                    clarifyTimeoutError: false
                },
                adapter: getDefaultAdapter(),
                transformRequest: [function transformRequest(data, headers) {
                    normalizeHeaderName(headers, "Accept");
                    normalizeHeaderName(headers, "Content-Type");
                    if (utils2.isFormData(data) || utils2.isArrayBuffer(data) || utils2.isBuffer(data) || utils2.isStream(data) || utils2.isFile(data) || utils2.isBlob(data)) {
                        return data;
                    }
                    if (utils2.isArrayBufferView(data)) {
                        return data.buffer;
                    }
                    if (utils2.isURLSearchParams(data)) {
                        setContentTypeIfUnset(headers, "application/x-www-form-urlencoded;charset=utf-8");
                        return data.toString();
                    }
                    if (utils2.isObject(data) || headers && headers["Content-Type"] === "application/json") {
                        setContentTypeIfUnset(headers, "application/json");
                        return stringifySafely(data);
                    }
                    return data;
                }],
                transformResponse: [function transformResponse(data) {
                    var transitional = this.transitional || defaults.transitional;
                    var silentJSONParsing = transitional && transitional.silentJSONParsing;
                    var forcedJSONParsing = transitional && transitional.forcedJSONParsing;
                    var strictJSONParsing = !silentJSONParsing && this.responseType === "json";
                    if (strictJSONParsing || forcedJSONParsing && utils2.isString(data) && data.length) {
                        try {
                            return JSON.parse(data);
                        } catch (e) {
                            if (strictJSONParsing) {
                                if (e.name === "SyntaxError") {
                                    throw enhanceError(e, this, "E_JSON_PARSE");
                                }
                                throw e;
                            }
                        }
                    }
                    return data;
                }],
                timeout: 0,
                xsrfCookieName: "XSRF-TOKEN",
                xsrfHeaderName: "X-XSRF-TOKEN",
                maxContentLength: -1,
                maxBodyLength: -1,
                validateStatus: function validateStatus(status) {
                    return status >= 200 && status < 300;
                },
                headers: {
                    common: {
                        "Accept": "application/json, text/plain, */*"
                    }
                }
            };
            utils2.forEach(["delete", "get", "head"], function forEachMethodNoData(method) {
                defaults.headers[method] = {};
            });
            utils2.forEach(["post", "put", "patch"], function forEachMethodWithData(method) {
                defaults.headers[method] = utils2.merge(DEFAULT_CONTENT_TYPE);
            });
            module.exports = defaults;
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/transformData.js
    var require_transformData = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/transformData.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            var defaults = require_defaults();
            module.exports = function transformData(data, headers, fns) {
                var context = this || defaults;
                utils2.forEach(fns, function transform(fn) {
                    data = fn.call(context, data, headers);
                });
                return data;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/cancel/isCancel.js
    var require_isCancel = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/cancel/isCancel.js"(exports, module) {
            "use strict";
            module.exports = function isCancel(value) {
                return !!(value && value.__CANCEL__);
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/dispatchRequest.js
    var require_dispatchRequest = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/dispatchRequest.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            var transformData = require_transformData();
            var isCancel = require_isCancel();
            var defaults = require_defaults();
            var Cancel = require_Cancel();
            function throwIfCancellationRequested(config) {
                if (config.cancelToken) {
                    config.cancelToken.throwIfRequested();
                }
                if (config.signal && config.signal.aborted) {
                    throw new Cancel("canceled");
                }
            }
            module.exports = function dispatchRequest(config) {
                throwIfCancellationRequested(config);
                config.headers = config.headers || {};
                config.data = transformData.call(config, config.data, config.headers, config.transformRequest);
                config.headers = utils2.merge(config.headers.common || {}, config.headers[config.method] || {}, config.headers);
                utils2.forEach(["delete", "get", "head", "post", "put", "patch", "common"], function cleanHeaderConfig(method) {
                    delete config.headers[method];
                });
                var adapter = config.adapter || defaults.adapter;
                return adapter(config).then(function onAdapterResolution(response) {
                    throwIfCancellationRequested(config);
                    response.data = transformData.call(config, response.data, response.headers, config.transformResponse);
                    return response;
                }, function onAdapterRejection(reason) {
                    if (!isCancel(reason)) {
                        throwIfCancellationRequested(config);
                        if (reason && reason.response) {
                            reason.response.data = transformData.call(config, reason.response.data, reason.response.headers, config.transformResponse);
                        }
                    }
                    return Promise.reject(reason);
                });
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/mergeConfig.js
    var require_mergeConfig = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/mergeConfig.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            module.exports = function mergeConfig(config1, config2) {
                config2 = config2 || {};
                var config = {};
                function getMergedValue(target, source) {
                    if (utils2.isPlainObject(target) && utils2.isPlainObject(source)) {
                        return utils2.merge(target, source);
                    } else if (utils2.isPlainObject(source)) {
                        return utils2.merge({}, source);
                    } else if (utils2.isArray(source)) {
                        return source.slice();
                    }
                    return source;
                }
                function mergeDeepProperties(prop) {
                    if (!utils2.isUndefined(config2[prop])) {
                        return getMergedValue(config1[prop], config2[prop]);
                    } else if (!utils2.isUndefined(config1[prop])) {
                        return getMergedValue(void 0, config1[prop]);
                    }
                }
                function valueFromConfig2(prop) {
                    if (!utils2.isUndefined(config2[prop])) {
                        return getMergedValue(void 0, config2[prop]);
                    }
                }
                function defaultToConfig2(prop) {
                    if (!utils2.isUndefined(config2[prop])) {
                        return getMergedValue(void 0, config2[prop]);
                    } else if (!utils2.isUndefined(config1[prop])) {
                        return getMergedValue(void 0, config1[prop]);
                    }
                }
                function mergeDirectKeys(prop) {
                    if (prop in config2) {
                        return getMergedValue(config1[prop], config2[prop]);
                    } else if (prop in config1) {
                        return getMergedValue(void 0, config1[prop]);
                    }
                }
                var mergeMap = {
                    "url": valueFromConfig2,
                    "method": valueFromConfig2,
                    "data": valueFromConfig2,
                    "baseURL": defaultToConfig2,
                    "transformRequest": defaultToConfig2,
                    "transformResponse": defaultToConfig2,
                    "paramsSerializer": defaultToConfig2,
                    "timeout": defaultToConfig2,
                    "timeoutMessage": defaultToConfig2,
                    "withCredentials": defaultToConfig2,
                    "adapter": defaultToConfig2,
                    "responseType": defaultToConfig2,
                    "xsrfCookieName": defaultToConfig2,
                    "xsrfHeaderName": defaultToConfig2,
                    "onUploadProgress": defaultToConfig2,
                    "onDownloadProgress": defaultToConfig2,
                    "decompress": defaultToConfig2,
                    "maxContentLength": defaultToConfig2,
                    "maxBodyLength": defaultToConfig2,
                    "transport": defaultToConfig2,
                    "httpAgent": defaultToConfig2,
                    "httpsAgent": defaultToConfig2,
                    "cancelToken": defaultToConfig2,
                    "socketPath": defaultToConfig2,
                    "responseEncoding": defaultToConfig2,
                    "validateStatus": mergeDirectKeys
                };
                utils2.forEach(Object.keys(config1).concat(Object.keys(config2)), function computeConfigValue(prop) {
                    var merge = mergeMap[prop] || mergeDeepProperties;
                    var configValue = merge(prop);
                    utils2.isUndefined(configValue) && merge !== mergeDirectKeys || (config[prop] = configValue);
                });
                return config;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/env/data.js
    var require_data = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/env/data.js"(exports, module) {
            module.exports = {
                "version": "0.24.0"
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/validator.js
    var require_validator = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/validator.js"(exports, module) {
            "use strict";
            var VERSION = require_data().version;
            var validators = {};
            ["object", "boolean", "number", "function", "string", "symbol"].forEach(function(type, i) {
                validators[type] = function validator(thing) {
                    return typeof thing === type || "a" + (i < 1 ? "n " : " ") + type;
                };
            });
            var deprecatedWarnings = {};
            validators.transitional = function transitional(validator, version, message) {
                function formatMessage(opt, desc) {
                    return "[Axios v" + VERSION + "] Transitional option '" + opt + "'" + desc + (message ? ". " + message : "");
                }
                return function(value, opt, opts) {
                    if (validator === false) {
                        throw new Error(formatMessage(opt, " has been removed" + (version ? " in " + version : "")));
                    }
                    if (version && !deprecatedWarnings[opt]) {
                        deprecatedWarnings[opt] = true;
                        console.warn(formatMessage(opt, " has been deprecated since v" + version + " and will be removed in the near future"));
                    }
                    return validator ? validator(value, opt, opts) : true;
                };
            };
            function assertOptions(options, schema, allowUnknown) {
                if (typeof options !== "object") {
                    throw new TypeError("options must be an object");
                }
                var keys = Object.keys(options);
                var i = keys.length;
                while (i-- > 0) {
                    var opt = keys[i];
                    var validator = schema[opt];
                    if (validator) {
                        var value = options[opt];
                        var result = value === void 0 || validator(value, opt, options);
                        if (result !== true) {
                            throw new TypeError("option " + opt + " must be " + result);
                        }
                        continue;
                    }
                    if (allowUnknown !== true) {
                        throw Error("Unknown option " + opt);
                    }
                }
            }
            module.exports = {
                assertOptions,
                validators
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/core/Axios.js
    var require_Axios = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/core/Axios.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            var buildURL = require_buildURL();
            var InterceptorManager = require_InterceptorManager();
            var dispatchRequest = require_dispatchRequest();
            var mergeConfig = require_mergeConfig();
            var validator = require_validator();
            var validators = validator.validators;
            function Axios(instanceConfig) {
                this.defaults = instanceConfig;
                this.interceptors = {
                    request: new InterceptorManager(),
                    response: new InterceptorManager()
                };
            }
            Axios.prototype.request = function request(config) {
                if (typeof config === "string") {
                    config = arguments[1] || {};
                    config.url = arguments[0];
                } else {
                    config = config || {};
                }
                config = mergeConfig(this.defaults, config);
                if (config.method) {
                    config.method = config.method.toLowerCase();
                } else if (this.defaults.method) {
                    config.method = this.defaults.method.toLowerCase();
                } else {
                    config.method = "get";
                }
                var transitional = config.transitional;
                if (transitional !== void 0) {
                    validator.assertOptions(transitional, {
                        silentJSONParsing: validators.transitional(validators.boolean),
                        forcedJSONParsing: validators.transitional(validators.boolean),
                        clarifyTimeoutError: validators.transitional(validators.boolean)
                    }, false);
                }
                var requestInterceptorChain = [];
                var synchronousRequestInterceptors = true;
                this.interceptors.request.forEach(function unshiftRequestInterceptors(interceptor) {
                    if (typeof interceptor.runWhen === "function" && interceptor.runWhen(config) === false) {
                        return;
                    }
                    synchronousRequestInterceptors = synchronousRequestInterceptors && interceptor.synchronous;
                    requestInterceptorChain.unshift(interceptor.fulfilled, interceptor.rejected);
                });
                var responseInterceptorChain = [];
                this.interceptors.response.forEach(function pushResponseInterceptors(interceptor) {
                    responseInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
                });
                var promise;
                if (!synchronousRequestInterceptors) {
                    var chain = [dispatchRequest, void 0];
                    Array.prototype.unshift.apply(chain, requestInterceptorChain);
                    chain = chain.concat(responseInterceptorChain);
                    promise = Promise.resolve(config);
                    while (chain.length) {
                        promise = promise.then(chain.shift(), chain.shift());
                    }
                    return promise;
                }
                var newConfig = config;
                while (requestInterceptorChain.length) {
                    var onFulfilled = requestInterceptorChain.shift();
                    var onRejected = requestInterceptorChain.shift();
                    try {
                        newConfig = onFulfilled(newConfig);
                    } catch (error) {
                        onRejected(error);
                        break;
                    }
                }
                try {
                    promise = dispatchRequest(newConfig);
                } catch (error) {
                    return Promise.reject(error);
                }
                while (responseInterceptorChain.length) {
                    promise = promise.then(responseInterceptorChain.shift(), responseInterceptorChain.shift());
                }
                return promise;
            };
            Axios.prototype.getUri = function getUri(config) {
                config = mergeConfig(this.defaults, config);
                return buildURL(config.url, config.params, config.paramsSerializer).replace(/^\?/, "");
            };
            utils2.forEach(["delete", "get", "head", "options"], function forEachMethodNoData(method) {
                Axios.prototype[method] = function(url, config) {
                    return this.request(mergeConfig(config || {}, {
                        method,
                        url,
                        data: (config || {}).data
                    }));
                };
            });
            utils2.forEach(["post", "put", "patch"], function forEachMethodWithData(method) {
                Axios.prototype[method] = function(url, data, config) {
                    return this.request(mergeConfig(config || {}, {
                        method,
                        url,
                        data
                    }));
                };
            });
            module.exports = Axios;
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/cancel/CancelToken.js
    var require_CancelToken = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/cancel/CancelToken.js"(exports, module) {
            "use strict";
            var Cancel = require_Cancel();
            function CancelToken(executor) {
                if (typeof executor !== "function") {
                    throw new TypeError("executor must be a function.");
                }
                var resolvePromise;
                this.promise = new Promise(function promiseExecutor(resolve) {
                    resolvePromise = resolve;
                });
                var token = this;
                this.promise.then(function(cancel) {
                    if (!token._listeners)
                        return;
                    var i;
                    var l = token._listeners.length;
                    for (i = 0; i < l; i++) {
                        token._listeners[i](cancel);
                    }
                    token._listeners = null;
                });
                this.promise.then = function(onfulfilled) {
                    var _resolve;
                    var promise = new Promise(function(resolve) {
                        token.subscribe(resolve);
                        _resolve = resolve;
                    }).then(onfulfilled);
                    promise.cancel = function reject() {
                        token.unsubscribe(_resolve);
                    };
                    return promise;
                };
                executor(function cancel(message) {
                    if (token.reason) {
                        return;
                    }
                    token.reason = new Cancel(message);
                    resolvePromise(token.reason);
                });
            }
            CancelToken.prototype.throwIfRequested = function throwIfRequested() {
                if (this.reason) {
                    throw this.reason;
                }
            };
            CancelToken.prototype.subscribe = function subscribe(listener) {
                if (this.reason) {
                    listener(this.reason);
                    return;
                }
                if (this._listeners) {
                    this._listeners.push(listener);
                } else {
                    this._listeners = [listener];
                }
            };
            CancelToken.prototype.unsubscribe = function unsubscribe(listener) {
                if (!this._listeners) {
                    return;
                }
                var index = this._listeners.indexOf(listener);
                if (index !== -1) {
                    this._listeners.splice(index, 1);
                }
            };
            CancelToken.source = function source() {
                var cancel;
                var token = new CancelToken(function executor(c) {
                    cancel = c;
                });
                return {
                    token,
                    cancel
                };
            };
            module.exports = CancelToken;
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/spread.js
    var require_spread = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/spread.js"(exports, module) {
            "use strict";
            module.exports = function spread(callback) {
                return function wrap(arr) {
                    return callback.apply(null, arr);
                };
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/helpers/isAxiosError.js
    var require_isAxiosError = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/helpers/isAxiosError.js"(exports, module) {
            "use strict";
            module.exports = function isAxiosError(payload) {
                return typeof payload === "object" && payload.isAxiosError === true;
            };
        }
    });

    // node_modules/rm2-typings/node_modules/axios/lib/axios.js
    var require_axios = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/lib/axios.js"(exports, module) {
            "use strict";
            var utils2 = require_utils();
            var bind = require_bind();
            var Axios = require_Axios();
            var mergeConfig = require_mergeConfig();
            var defaults = require_defaults();
            function createInstance(defaultConfig) {
                var context = new Axios(defaultConfig);
                var instance = bind(Axios.prototype.request, context);
                utils2.extend(instance, Axios.prototype, context);
                utils2.extend(instance, context);
                instance.create = function create(instanceConfig) {
                    return createInstance(mergeConfig(defaultConfig, instanceConfig));
                };
                return instance;
            }
            var axios = createInstance(defaults);
            axios.Axios = Axios;
            axios.Cancel = require_Cancel();
            axios.CancelToken = require_CancelToken();
            axios.isCancel = require_isCancel();
            axios.VERSION = require_data().version;
            axios.all = function all(promises) {
                return Promise.all(promises);
            };
            axios.spread = require_spread();
            axios.isAxiosError = require_isAxiosError();
            module.exports = axios;
            module.exports.default = axios;
        }
    });

    // node_modules/rm2-typings/node_modules/axios/index.js
    var require_axios2 = __commonJS({
        "node_modules/rm2-typings/node_modules/axios/index.js"(exports, module) {
            module.exports = require_axios();
        }
    });

    // node_modules/rm2-typings/dist/utils.js
    var require_utils2 = __commonJS({
        "node_modules/rm2-typings/dist/utils.js"(exports) {
            "use strict";
            var __importDefault = exports && exports.__importDefault || function(mod) {
                return mod && mod.__esModule ? mod : { "default": mod };
            };
            Object.defineProperty(exports, "__esModule", { value: true });
            exports.createRoute = exports.buildRouteMaker = exports.request = exports.getAxiosInstance = exports.setupConfig = void 0;
            var axios_1 = __importDefault(require_axios2());
            var rest;
            function setupConfig(config) {
                rest = axios_1.default.create(config);
                return config;
            }
            exports.setupConfig = setupConfig;
            function getAxiosInstance() {
                if (!rest)
                    throw new Error("Axios config not defined. Please call the utils.setupConfig() method!");
                return rest;
            }
            exports.getAxiosInstance = getAxiosInstance;
            async function request(method, route, body, config) {
                if (!rest)
                    throw new Error("Axios config not defined. Please call the utils.setupConfig() method!");
                const _method = method.toLowerCase();
                switch (_method) {
                    case "get":
                    case "delete":
                        return rest[_method](route, config);
                    default:
                        return rest[_method](route, body, config);
                }
            }
            exports.request = request;
            function buildRouteMaker(router) {
                return function route(method, route, ...listeners) {
                    createRoute(router, method, route, ...listeners);
                };
            }
            exports.buildRouteMaker = buildRouteMaker;
            function createRoute(router, method, route, ...listeners) {
                const _method = method.toLowerCase();
                router[_method](route, ...listeners);
            }
            exports.createRoute = createRoute;
        }
    });

    // node_modules/rm2-typings/dist/types/scalable.js
    var require_scalable = __commonJS({
        "node_modules/rm2-typings/dist/types/scalable.js"(exports) {
            "use strict";
            Object.defineProperty(exports, "__esModule", { value: true });
        }
    });

    // node_modules/rm2-typings/dist/index.js
    var require_dist = __commonJS({
        "node_modules/rm2-typings/dist/index.js"(exports) {
            "use strict";
            var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
                if (k2 === void 0)
                    k2 = k;
                Object.defineProperty(o, k2, { enumerable: true, get: function() {
                        return m[k];
                    } });
            } : function(o, m, k, k2) {
                if (k2 === void 0)
                    k2 = k;
                o[k2] = m[k];
            });
            var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
                Object.defineProperty(o, "default", { enumerable: true, value: v });
            } : function(o, v) {
                o["default"] = v;
            });
            var __importStar = exports && exports.__importStar || function(mod) {
                if (mod && mod.__esModule)
                    return mod;
                var result = {};
                if (mod != null) {
                    for (var k in mod)
                        if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k))
                            __createBinding(result, mod, k);
                }
                __setModuleDefault(result, mod);
                return result;
            };
            var __exportStar = exports && exports.__exportStar || function(m, exports2) {
                for (var p in m)
                    if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p))
                        __createBinding(exports2, m, p);
            };
            Object.defineProperty(exports, "__esModule", { value: true });
            exports.utils = exports.full = exports.api = exports.tables = void 0;
            exports.tables = __importStar(require_tables());
            exports.api = __importStar(require_api());
            exports.full = __importStar(require_full());
            exports.utils = __importStar(require_utils2());
            __exportStar(require_scalable(), exports);
        }
    });

    // src/index.ts
    var src_exports = {};
    __export(src_exports, {
        WriteConnection: () => WriteConnection
    });
    var types = __toModule(require_dist());
    var WriteConnection = class {
        constructor(_config) {
            this._config = _config;
            this._eventQueue = [];
            this._event_counter = 0;
            this._buffering = false;
            this._bufferingInterval = null;
            this._connected = false;
            this._api = types.utils.request;
            var _a, _b, _c;
            const protocol = (_a = _config.protocol) != null ? _a : "http";
            const host = (_b = _config.host) != null ? _b : "localhost";
            const portString = _config.port ? `:${_config.port}` : "";
            const path = (_c = _config.path) != null ? _c : "/v2";
            types.utils.setupConfig({
                params: { apikey: _config.apiKey },
                baseURL: `${protocol}://${host}${portString}${path}`
            });
        }
        get isConnected() {
            return this._connected;
        }
        get sessionId() {
            return this._sessionId;
        }
        async connect() {
            var _a;
            console.log("RM2: WriteConnection connecting...");
            if (this._connected) {
                console.warn("RM2: WriteConnection is already connected");
                return;
            }
            const apiKey = await this._api("Get", "/key", void 0);
            if (!apiKey)
                throw new Error("Invalid API key !");
            console.log("RM2: WriteConnection connected");
            const { data } = await this._api("Post", "/session", this._config.session ? this._config.session : {});
            this._sessionId = data.id;
            console.log("created session", this._sessionId);
            this._connected = true;
            this._bufferingInterval = setInterval(this.sendData.bind(this), (_a = this._config.bufferingDelay) != null ? _a : 1e3);
        }
        async disconnect(emitted) {
            if (!this._connected) {
                console.warn("RM2: WriteConnection already disconnected");
                return;
            }
            clearInterval(this._bufferingInterval);
            this.postEvent(__spreadProps(__spreadValues({}, emitted), { type: "end" }));
            await this.sendData();
            this._bufferingInterval = null;
            this._connected = false;
        }
        async sendData() {
            const startCounter = this._event_counter;
            if (this._buffering || this._eventQueue.length === 0)
                return 0;
            if (!this._connected) {
                throw new Error("RM2: \u274C WriteConnection client not connected");
            }
            this._buffering = true;
            const eventData = this._eventQueue.map((event) => __spreadProps(__spreadValues({}, event), {
                sessionId: this._sessionId
            }));
            console.log("RM2: WriteConnection sending events", startCounter - this._eventQueue.length , "to", startCounter - 1, JSON.parse(JSON.stringify(eventData)));
            try {
                await this._api("Post", "/event", eventData);
                const sentCount = eventData.length;
                this._eventQueue.splice(0, sentCount);
                eventData.length = 0;
            } catch (error) {
                if (/[45]\d{2}/.test(error.message)) {
                    this._connected = false;
                    console.error(error);
                    throw new Error("RM2: \u274C WriteConnection connection crash");
                } else {
                }
            }
            this._buffering = false;
            return eventData.length;
        }
        postEvent(event) {
            if (!event.userTimestamp)
                event.userTimestamp = new Date().toISOString();
            
            console.log("RM2: postEvent called", {
                queueLength: this._eventQueue.length,
                eventCounter: this._event_counter
            });

            this._eventQueue.push(event);
            console.log("RM2: Add Event", this._event_counter, "to queue: ", event);
            this._event_counter++;

            console.log("RM2: event pushed to queue", {
                queueLength: this._eventQueue.length,
                eventCounter: this._event_counter
            });
        }        
        async updateSession(session) {
            this._config.session = session;
            if (!this._connected)
                return;
            console.log("RM2: WriteConnection updating session", session);
            await this._api("Put", `/session/${this._sessionId}`, session);
        }
    };
    return src_exports;
})();



'use strict';

const assert = require('node:assert');
const { kDestroyed, kBodyUsed, kListeners, kBody } = require('./symbols');
const { IncomingMessage } = require('node:http');
const stream = require('node:stream');
const net = require('node:net');
const { Blob } = require('node:buffer');
const { stringify } = require('node:querystring');
const { InvalidArgumentError } = require('./errors');
const { headerNameLowerCasedRecord } = require('./constants');
const { tree } = require('./tree');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(v => Number(v))
const normalizedMethodRecordsBase = Object.freeze({
  DELETE: 'DELETE',
  GET: 'GET',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH', 
});
/**
 * Asynchronous iterable for request body handling.
 */
class BodyAsyncIterable {
  constructor(body) {
    this[kBody] = body;
    this[kBodyUsed] = false; // Ensures body can only be read once
  }

  async * [Symbol.asyncIterator]() {
    assert(!this[kBodyUsed], 'Body has already been used');
    this[kBodyUsed] = true;
    yield* this[kBody]; // Stream or Async iterable
  }
}

/**
 * Wraps request body into a suitable format for processing.
 * @param {*} body The request body
 * @returns {stream.Readable|BodyAsyncIterable|*}
 */
function wrapRequestBody(body) {
  if (isStream(body)) return body;
  if (isAsyncIterable(body) || isIterable(body)) return new BodyAsyncIterable(body);
  return body;
}

/**
 * Checks if an object is a Stream.
 * @param {*} obj
 * @returns {boolean}
 */
function isStream(obj) {
  return obj && typeof obj === 'object' && typeof obj.pipe === 'function';
}

/**
 * Checks if an object is Blob-like.
 * @param {*} object
 * @returns {boolean}
 */
function isBlobLike(object) {
  return object instanceof Blob || (object && (object[Symbol.toStringTag] === 'Blob' || object[Symbol.toStringTag] === 'File') 
    && (typeof object.stream === 'function' || typeof object.arrayBuffer === 'function'));
}

/**
 * Serializes URL path with query parameters.
 * @param {string} url The URL
 * @param {import('node:querystring').ParsedUrlQueryInput} queryParams The query parameters
 * @returns {string}
 * @throws {Error} If the URL already contains query params
 */
function serializePathWithQuery(url, queryParams) {
  if (typeof queryParams !== 'object') {
    throw new InvalidArgumentError('Query parameters must be an object.');
  }

  if (url.includes('?') || url.includes('#')) {
    throw new Error('Query params cannot be passed when URL already contains "?".');
  }

  const stringified = stringify(queryParams);
  return stringified ? `${url}?${stringified}` : url;
}

/**
 * Validates a port number.
 * @param {number|string|undefined} port
 * @returns {boolean}
 */
function isValidPort(port) {
  const value = parseInt(port, 10);
  return Number.isFinite(value) && value >= 0 && value <= 65535;
}

/**
 * Checks if the string is an HTTP or HTTPS prefixed URL.
 * @param {string} value
 * @returns {boolean}
 */
function isHttpOrHttpsPrefixed(value) {
  return value && /^(http|https):/.test(value);
}

/**
 * Parses and validates a URL.
 * @param {string|URL|Record<string, string>} url
 * @returns {URL}
 * @throws {InvalidArgumentError} If the URL is invalid
 */
function parseURL(url) {
  if (typeof url === 'string') {
    const parsedURL = new URL(url);
    validateURLProtocol(parsedURL);
    return parsedURL;
  } else if (url && typeof url === 'object' && !(url instanceof URL)) {
    validateURLStructure(url);
    return constructURLFromObject(url);
  } else if (!(url instanceof URL)) {
    throw new InvalidArgumentError('Invalid URL: must be a URL object.');
  }

  validateURLProtocol(url);
  return url;
}

/**
 * Validates the protocol of a URL.
 * @param {URL} url
 * @throws {InvalidArgumentError} If the URL protocol is invalid
 */
function validateURLProtocol(url) {
  if (!isHttpOrHttpsPrefixed(url.origin || url.protocol)) {
    throw new InvalidArgumentError('Invalid URL protocol: must start with `http:` or `https:`.');
  }
}

/**
 * Validates the structure of a URL object.
 * @param {Record<string, string>} url
 * @throws {InvalidArgumentError} If the URL structure is invalid
 */
function validateURLStructure(url) {
  if (url.port != null && !isValidPort(url.port)) {
    throw new InvalidArgumentError('Invalid port: must be a valid integer or string representation of an integer.');
  }

  for (const key of ['path', 'pathname', 'hostname', 'origin']) {
    if (url[key] != null && typeof url[key] !== 'string') {
      throw new InvalidArgumentError(`Invalid URL ${key}: must be a string or null/undefined.`);
    }
  }
}

/**
 * Constructs a URL from a URL object.
 * @param {Record<string, string>} url
 * @returns {URL}
 */
function constructURLFromObject(url) {
  const port = url.port ?? (url.protocol === 'https:' ? 443 : 80);
  const origin = url.origin ?? `${url.protocol}//${url.hostname}:${port}`;
  const path = url.path ?? url.pathname + (url.search || '');

  return new URL(`${origin}${path.startsWith('/') ? path : '/' + path}`);
}

/**
 * Gets the hostname from a host header.
 * @param {string} host
 * @returns {string}
 */
function getHostname(host) {
  return host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
}

/**
 * Retrieves the server name.
 * @param {string|null} host
 * @returns {string|null}
 */
function getServerName(host) {
  if (!host || typeof host !== 'string') return null;
  const servername = getHostname(host);
  return net.isIP(servername) ? '' : servername;
}

/**
 * Clones an object deeply using structured cloning.
 * @param {*} obj
 * @returns {any}
 */
function deepClone(obj) {
  return structuredClone(obj);
}

/**
 * Checks if an object is AsyncIterable.
 * @param {*} obj
 * @returns {boolean}
 */
function isAsyncIterable(obj) {
  return obj != null && typeof obj[Symbol.asyncIterator] === 'function';
}

/**
 * Checks if an object is Iterable.
 * @param {*} obj
 * @returns {boolean}
 */
function isIterable(obj) {
  return obj != null && typeof obj[Symbol.iterator] === 'function';
}

/**
 * Gets the body length of a stream.
 * @param {Blob|Buffer|stream.Readable} body
 * @returns {number|null}
 */
function bodyLength(body) {
  if (!body) return 0;

  if (isStream(body)) {
    const state = body._readableState;
    return state && !state.objectMode && state.ended && Number.isFinite(state.length) ? state.length : null;
  }

  if (isBlobLike(body)) return body.size ?? null;
  if (Buffer.isBuffer(body)) return body.byteLength;

  return null;
}

/**
 * Checks if a stream has been destroyed.
 * @param {stream.Stream} body
 * @returns {boolean}
 */
function isDestroyed(body) {
  return body && (body.destroyed || body[kDestroyed] || (stream.isDestroyed?.(body) ?? false));
}

/**
 * Destroys a stream safely, emitting an error if provided.
 * @param {stream.Stream} stream
 * @param {Error} [err]
 */
function destroy(stream, err) {
  if (!stream || !isStream(stream) || isDestroyed(stream)) return;
  if (stream instanceof IncomingMessage) stream.socket = null;

  // Use a conditional to avoid unnecessary function calls
  if (typeof stream.destroy === 'function') {
    stream.destroy(err);
  } else if (err) {
    queueMicrotask(() => stream.emit('error', err));
  } 
  stream[kDestroyed] = true;
}

/**
 * Parses the keep-alive timeout from a string.
 * @param {string} val
 * @returns {number | null}
 */
function parseKeepAliveTimeout(val) {
  const match = /timeout=(\d+)/.exec(val);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

/**
 * Retrieves a header name as a lowercase string.
 * @param {string | Buffer} value
 * @returns {string}
 */
function headerNameToString(value) {
  if (typeof value === 'string') {
    return headerNameLowerCasedRecord[value] ?? value.toLowerCase();
  }
  return tree.lookup(value) ?? value.toString('latin1').toLowerCase();
}

/**
 * Parses headers into an object.
 * @param {(Buffer | string)[]} headers
 * @param {Record<string, string | string[]>} [obj]
 * @returns {Record<string, string | string[]>}
 */
function parseHeaders(headers, obj = {}) {
  for (let i = 0; i < headers.length; i += 2) {
    const key = headerNameToString(headers[i]);
    const value = headers[i + 1].toString('utf8');

    if (!obj[key]) {
      obj[key] = value;
    } else {
      obj[key] = Array.isArray(obj[key]) ? [...obj[key], value] : [obj[key], value];
    }
  }

  // Handle content-disposition encoding
  if ('content-length' in obj && 'content-disposition' in obj) {
    obj['content-disposition'] = Buffer.from(obj['content-disposition']).toString('latin1');
  }

  return obj;
}
// Helper functions
const isBuffer = (buffer) => Buffer.isBuffer(buffer) || buffer instanceof Uint8Array;
/**
 * Encodes raw header strings into Buffers.
 * @param {string[]} headers
 * @returns {Buffer[]}
 */
function encodeRawHeaders(headers) {
  return headers.map(header => Buffer.from(header));
}

/**
 * Asserts the validity of a request handler.
 * @param {object} handler
 * @param {string} method
 * @param {string} [upgrade]
 */
function assertRequestHandler(handler, method, upgrade) {
  assert(typeof handler === 'object', 'Handler must be an object');
  
  const requiredMethods = ['onConnect', 'onError'];
  
  if (!(upgrade || method === 'CONNECT')) {
    requiredMethods.push('onHeaders', 'onData', 'onComplete');
  }

  for (const methodName of requiredMethods) {
    assert(typeof handler[methodName] === 'function', `Invalid ${methodName} method`);
  }
}

/**
 * Checks if a readable stream has been disturbed.
 * @param {import('node:stream').Readable} body
 * @returns {boolean}
 */
function isDisturbed(body) {
  return !!(body && (stream.isDisturbed(body) || body[kBodyUsed]));
}

/**
 * Retrieves socket info from a socket.
 * @param {import('net').Socket} socket
 * @returns {SocketInfo}
 */
function getSocketInfo(socket) {
  const { localAddress, localPort, remoteAddress, remotePort, remoteFamily, timeout, bytesWritten, bytesRead } = socket;

  return {
    localAddress,
    localPort,
    remoteAddress,
    remotePort,
    remoteFamily,
    timeout,
    bytesWritten,
    bytesRead,
  };
}

/**
 * Converts a value to a USV string.
 * @param {string} value
 * @returns {string}
 */
const toUSVString = (value) => String(value); // Simplified without well-formed check

/**
 * Checks if a value is a valid USV string.
 * @param {*} value
 * @returns {boolean}
 */
const isUSVString = (value) => typeof value === 'string' && value === toUSVString(value);

/**
 * Checks if a character code is a valid HTTP token character code.
 * @param {number} c
 * @returns {boolean}
 */
const isTokenCharCode = (c) => !(
  c === 0x22 || (c >= 0x28 && c <= 0x29) ||
  (c >= 0x2c && c <= 0x2f) || (c >= 0x3a && c <= 0x3e) ||
  (c >= 0x40 && c <= 0x5d) || (c >= 0x7b && c <= 0x7d) ||
  (c < 0x21 || c > 0x7e)
);

/**
 * Checks if a string is a valid HTTP token.
 * @param {string} str
 * @returns {boolean}
 */
const isValidHTTPToken = (str) => str.length > 0 && [...str].every(c => isTokenCharCode(c.charCodeAt(0)));

/**
 * Checks if a string is a valid header value.
 * @param {string} str
 * @returns {boolean}
 */
const isValidHeaderValue = (str) => !/[^\t\x20-\x7e\x80-\xff]/.test(str);

/**
 * Parses the Range header.
 * @param {string} range
 * @returns {{ start: number, end: number | null, size: number | null }}
 */
const parseRangeHeader = (range) => {
  if (!range) return { start: 0, end: null, size: null };
  const match = /^bytes=(\d+)-(\d+)\/(\d+)?$/.exec(range);
  if (!match) return null;

  return {
    start: parseInt(match[1], 10),
    end: match[2] ? parseInt(match[2], 10) : null,
    size: match[3] ? parseInt(match[3], 10) : null,
  };
};

/**
 * Adds a listener to an object, keeping track of it.
 * @param {object} obj
 * @param {string} name
 * @param {Function} listener
 * @returns {object}
 */
function addListener(obj, name, listener) {
  const listeners = obj[kListeners] ||= [];
  listeners.push([name, listener]);
  obj.on(name, listener);
  return obj;
}

/**
 * Removes all listeners attached to an object.
 * @param {object} obj
 * @returns {object}
 */
function removeAllListeners(obj) {
  const listeners = obj[kListeners];
  if (listeners) {
    for (const [name, listener] of listeners) {
      obj.removeListener(name, listener);
    }
    obj[kListeners] = null; // Help GC
  }
  return obj;
}

/**
 * Handles an error in the request.
 * @param {object} client
 * @param {object} request
 * @param {Error} err
 */
function errorRequest(client, request, err) {
  try {
    request.onError(err);
    assert(request.aborted);
  } catch (error) {
    client.emit('error', error);
  }
}

/**
 * Parses the origin URL.
 * @param {string} url
 * @returns {URL}
 */
function parseOrigin(url) {
  url = parseURL(url);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new InvalidArgumentError('Invalid URL');
  }
  return url;
}

/**
 * Converts Buffer to lowercased header name.
 * @param {Buffer} value
 * @returns {string}
 */
function bufferToLowerCasedHeaderName(value) {
  return tree.lookup(value) ?? value.toString('latin1').toLowerCase();
}

/**
 * Parses raw headers into an array of strings.
 * @param {Buffer[]} headers
 * @returns {string[]}
 */
function parseRawHeaders(headers) {
  const ret = new Array(headers.length);

  let hasContentLength = false;
  let contentDispositionIdx = -1;

  for (let n = 0; n < headers.length; n += 2) {
    const key = headers[n].toString();
    const val = headers[n + 1].toString('utf8');

    if (key.toLowerCase() === 'content-length') {
      hasContentLength = true;
    } else if (key.toLowerCase() === 'content-disposition') {
      contentDispositionIdx = n + 1;
    }

    ret[n] = key;
    ret[n + 1] = val;
  }

  if (hasContentLength && contentDispositionIdx !== -1) {
    ret[contentDispositionIdx] = Buffer.from(ret[contentDispositionIdx]).toString('latin1');
  }

  return ret;
}

/**
 * Converts an iterable to a ReadableStream.
 * @param {Iterable|AsyncIterable} iterable
 * @returns {ReadableStream}
 */
function ReadableStreamFrom(iterable) {
  return new ReadableStream({
    async start(controller) {
      const iterator = iterable[Symbol.asyncIterator]();
      let result;

      while (!(result = await iterator.next()).done) {
        const buf = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
        if (buf.byteLength) {
          controller.enqueue(new Uint8Array(buf));
        }
      }
      controller.close();
    },
    type: 'bytes'
  });
}

/**
 * Adds an abort listener for the signal.
 * @param {AbortSignal} signal
 * @param {Function} listener
 * @returns {Function}
 */
function addAbortListener(signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

/**
 * Checks if an object is form data-like.
 * @param {any} object
 * @returns {boolean}
 */
function isFormDataLike(object) {
  return object && typeof object === 'object' &&
    ['append', 'delete', 'get', 'getAll', 'has', 'set'].every(method => typeof object[method] === 'function') &&
    object[Symbol.toStringTag] === 'FormData';
}
const normalizedMethodRecords = {
  ...normalizedMethodRecordsBase,
  patch: 'patch',
  PATCH: 'PATCH'
}
const kEnumerableProperty = Object.create(null)
kEnumerableProperty.enumerable = true
module.exports = {
  kEnumerableProperty,
  isDisturbed,
  toUSVString,
  isUSVString,
  isBlobLike,
  parseOrigin,
  parseURL,
  getServerName,
  isStream,
  isIterable,
  isAsyncIterable,
  isDestroyed,
  headerNameToString,
  bufferToLowerCasedHeaderName,
  addListener,
  removeAllListeners,
  errorRequest,
  parseRawHeaders,
  encodeRawHeaders,
  parseHeaders,
  parseKeepAliveTimeout,
  destroy,
  bodyLength,
  deepClone,
  ReadableStreamFrom,
  isBuffer,
  assertRequestHandler,
  getSocketInfo,
  isFormDataLike,
  serializePathWithQuery,
  addAbortListener,
  isValidHTTPToken,
  isValidHeaderValue,
  isTokenCharCode,
  parseRangeHeader,
  normalizedMethodRecordsBase,
  normalizedMethodRecords,
  isValidPort,
  isHttpOrHttpsPrefixed,
  nodeMajor,
  nodeMinor,
  safeHTTPMethods: Object.freeze(['GET', 'HEAD', 'OPTIONS', 'TRACE']),
  wrapRequestBody
}

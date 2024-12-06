
class Request {
  #headers;
  #handler;
  #abort;
  #error;
  
  constructor(origin, options, handler) {
    this.validateInputs(options);

    this.headersTimeout = options.headersTimeout;
    this.bodyTimeout = options.bodyTimeout;
    this.method = options.method;
    this.body = options.body ? this.processBody(options.body) : null;
    this.completed = false;
    this.aborted = false;
    this.upgrade = options.upgrade || null;
    this.path = options.query ? this.serializePathWithQuery(options.path, options.query) : options.path;
    this.origin = origin;
    this.idempotent = options.idempotent ?? (this.method === 'HEAD' || this.method === 'GET');
    this.blocking = options.blocking ?? this.method !== 'HEAD';
    this.reset = options.reset ?? null;
    this.host = null;
    this.contentLength = null;
    this.contentType = null;

    this.#headers = new Map();
    this.processHeaders(options.headers);
    this.assertRequestHandler(handler, options.method, options.upgrade);
    this.#handler = handler;

    // Publish creation event
    if (channels.create.hasSubscribers) {
      channels.create.publish({ request: this });
    }
  }

  validateInputs(options) {
    const { path, method, upgrade, headersTimeout, bodyTimeout, reset, expectContinue, throwOnError } = options;

    if (typeof path !== 'string') throw new InvalidArgumentError('Path must be a string.');
    if (!path.startsWith('/') && !path.startsWith('http://') && !path.startsWith('https://') && method !== 'CONNECT') {
      throw new InvalidArgumentError('Path must be an absolute URL or start with a slash.');
    }
    if (invalidPathRegex.test(path)) throw new InvalidArgumentError('Invalid request path.');
    if (typeof method !== 'string' || (!normalizedMethodRecords[method] && !isValidHTTPToken(method))) {
      throw new InvalidArgumentError('Invalid request method.');
    }
    if (upgrade && typeof upgrade !== 'string') throw new InvalidArgumentError('Upgrade must be a string.');
    this.checkTimeoutValidity(headersTimeout, 'headersTimeout');
    this.checkTimeoutValidity(bodyTimeout, 'bodyTimeout');
    if (reset != null && typeof reset !== 'boolean') throw new InvalidArgumentError('Invalid reset.');
    this.checkBooleanValidation(expectContinue, 'expectContinue');
    this.checkUndefined(throwOnError, 'throwOnError');
  }

  checkTimeoutValidity(value, name) {
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      throw new InvalidArgumentError(`Invalid ${name}.`);
    }
  }
  
  checkBooleanValidation(value, name) {
    if (value != null && typeof value !== 'boolean') {
      throw new InvalidArgumentError(`Invalid ${name}.`);
    }
  }

  checkUndefined(value, name) {
    if (value != null) {
      throw new InvalidArgumentError(`Invalid ${name}.`);
    }
  }

  processBody(body) {
    if (isStream(body)) {
      this.setupStream(body);
      return body;
    }
    if (isBuffer(body) || ArrayBuffer.isView(body) || typeof body === 'string') {
      return body.length ? Buffer.from(body) : null;
    }
    if (isFormDataLike(body) || isIterable(body) || isBlobLike(body)) {
      return body;
    }
    throw new InvalidArgumentError('Body must be a valid type (string, Buffer, Readable stream, iterable, or async iterable).');
  }

  setupStream(body) {
    const rState = body._readableState;
    if (!rState || !rState.autoDestroy) {
      this.endHandler = () => this.cleanupStreamListeners(body);
      body.on('end', this.endHandler);
    }
    this.errorHandler = (err) => this.#abort ? this.#abort(err) : this.#error = err;
    body.on('error', this.errorHandler);
  }

  cleanupStreamListeners(body) {
    if (this.errorHandler) {
      body.off('error', this.errorHandler);
      this.errorHandler = null;
    }
    if (this.endHandler) {
      body.off('end', this.endHandler);
      this.endHandler = null;
    }
  }

  processHeaders(headers) {
    if (Array.isArray(headers)) {
      if (headers.length % 2 !== 0) throw new InvalidArgumentError('Headers array must be even.');
      for (let i = 0; i < headers.length; i += 2) {
        this.addHeader(headers[i], headers[i + 1]);
      }
    } else if (headers && typeof headers === 'object') {
      for (const [key, val] of Object.entries(headers)) {
        this.addHeader(key, val);
      }
    } else if (headers != null) {
      throw new InvalidArgumentError('Headers must be an object or an array.');
    }
  }

  addHeader(key, value) {
    if (value === undefined) return;

    const headerName = headerNameLowerCasedRecord[key] || key.toLowerCase();
    if (!headerNameLowerCasedRecord[headerName] && !isValidHTTPToken(headerName)) {
      throw new InvalidArgumentError('Invalid header key.');
    }

    if (Array.isArray(value)) {
      value = value.map(v => typeof v === 'string' && isValidHeaderValue(v) ? v : (v === null ? '' : `${v}`));
    } else if (typeof value === 'string' && !isValidHeaderValue(value)) {
      throw new InvalidArgumentError(`Invalid ${key} header.`);
    } else {
      value = value === null ? '' : `${value}`;
    }

    this.assignHeader(headerName, value, key);
  }

  assignHeader(headerName, value, originalKey) {
    switch(headerName) {
      case 'host':
        if (this.host === null && typeof value === 'string') {
          this.host = value;
        }
        break;
      case 'content-length':
        if (this.contentLength === null) {
          this.contentLength = parseInt(value, 10);
          if (!Number.isFinite(this.contentLength)) {
            throw new InvalidArgumentError('Invalid content-length header.');
          }
        }
        break;
      case 'content-type':
        if (this.contentType === null) {
          this.contentType = value;
          this.#headers.set(originalKey, value);
        }
        break;
      case 'transfer-encoding':
      case 'keep-alive':
      case 'upgrade':
        throw new InvalidArgumentError(`Invalid ${headerName} header.`);
      case 'connection':
        const connValue = typeof value === 'string' ? value.toLowerCase() : null;
        if (!['close', 'keep-alive'].includes(connValue)) {
          throw new InvalidArgumentError('Invalid connection header');
        }
        if (connValue === 'close') this.reset = true;
        break;
      case 'expect':
        throw new NotSupportedError('Expect header not supported.');
      default:
        this.#headers.set(originalKey, value);
    }
  }

  onBodySent(chunk) {
    return this.invokeHandlerMethod('onBodySent', chunk);
  }

  onRequestSent() {
    if (channels.bodySent.hasSubscribers) {
      channels.bodySent.publish({ request: this });
    }
    return this.invokeHandlerMethod('onRequestSent');
  }

  onConnect(abort) {
    assert(!this.aborted);
    assert(!this.completed);
    
    if (this.#error) {
      abort(this.#error);
    } else {
      this.#abort = abort;
      return this.invokeHandlerMethod('onConnect', abort);
    }
  }

  onResponseStarted() {
    return this.invokeHandlerMethod('onResponseStarted');
  }

  onHeaders(statusCode, headers, resume, statusText) {
    assert(!this.aborted);
    assert(!this.completed);
    
    if (channels.headers.hasSubscribers) {
      channels.headers.publish({ request: this, response: { statusCode, headers, statusText } });
    }
    return this.invokeHandlerMethod('onHeaders', statusCode, headers, resume, statusText);
  }

  onData(chunk) {
    assert(!this.aborted);
    assert(!this.completed);
    return this.invokeHandlerMethod('onData', chunk);
  }

  onUpgrade(statusCode, headers, socket) {
    assert(!this.aborted);
    assert(!this.completed);
    return this.invokeHandlerMethod('onUpgrade', statusCode, headers, socket);
  }

  onComplete(trailers) {
    this.onFinally();
    assert(!this.aborted);
    assert(!this.completed);
    
    this.completed = true;
    if (channels.trailers.hasSubscribers) {
      channels.trailers.publish({ request: this, trailers });
    }
    return this.invokeHandlerMethod('onComplete', trailers);
  }

  onError(error) {
    this.onFinally();
    if (channels.error.hasSubscribers) {
      channels.error.publish({ request: this, error });
    }
    if (this.aborted) return;

    this.aborted = true;
    return this.invokeHandlerMethod('onError', error);
  }

  invokeHandlerMethod(method, ...args) {
    if (this.#handler[method]) {
      try {
        return this.#handler[method](...args);
      } catch (err) {
        this.abort(err);
      }
    }
    return undefined;
  }

  onFinally() {
    this.cleanupStreamListeners(this.body);
  }
}

module.exports = Request;

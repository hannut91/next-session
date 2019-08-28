const crypto = require('crypto');
const parseCookie = require('cookie').parse;
const { promisify } = require('util');
const MemoryStore = require('./session/memory');
const Store = require('./session/store');
const Cookie = require('./session/cookie');
const Session = require('./session/session');
const { parseToMs } = require('./session/utils');
//  environment
const env = process.env.NODE_ENV;

const generateSessionId = () => crypto.randomBytes(16).toString('hex');

const hash = (sess) => {
  const str = JSON.stringify(sess, (key, val) => {
    if (key === 'cookie') {
      //  filtered out session.cookie
      return undefined;
    }
    return val;
  });
  //  hash
  return crypto
    .createHash('sha1')
    .update(str, 'utf8')
    .digest('hex');
};

const session = (handler, options = {}) => {
  const name = options.name || 'sessionId';
  const cookieOptions = options.cookie || {};
  const store = options.store || new MemoryStore();
  const generateId = options.generateId || generateSessionId;
  const touchAfter = options.touchAfter ? parseToMs(options.touchAfter) : 0;
  const rollingSession = options.rolling || false;
  const storePromisify = options.storePromisify || false;

  //  Notify MemoryStore should not be used in production
  if (env === 'production' && store instanceof MemoryStore) {
    // eslint-disable-next-line no-console
    console.warn('MemoryStore is not designed for production environment.');
  }

  //  Validate parameters
  if (typeof generateId !== 'function') throw new TypeError('generateId option must be a function');

  //  Promisify callback-based store.
  if (storePromisify) {
    store.get = promisify(store.get);
    store.set = promisify(store.set);
    store.destroy = promisify(store.destroy);
    if (typeof store.touch === 'function') store.touch = promisify(store.touch);
  }

  //  store readiness
  let storeReady = true;
  store.on('disconnect', () => {
    storeReady = false;
  });
  store.on('connect', () => {
    storeReady = true;
  });

  return (req, res) => {
    //  No need to redefine
    if (req.session) return handler(req, res);

    //  check for store readiness before proceeded

    if (!storeReady) return handler(req, res);

    //  TODO: add pathname mismatch check

    //  Expose store
    req.sessionStore = store;

    //  Get sessionId cookie from Next.js parsed req.cookies
    req.sessionId = req.cookies[name];

    const getSession = () => {
      //  Return a session object
      if (!req.sessionId) {
        //  If no sessionId found in Cookie header, generate one
        return Promise.resolve(hash(req.sessionStore.generate(req, generateId(), cookieOptions)));
      }
      return req.sessionStore.get(req.sessionId)
        .then((sess) => {
          if (sess) {
            return hash(req.sessionStore.createSession(req, sess));
          }
          return hash(req.sessionStore.generate(req, generateId(), cookieOptions));
        });
    };

    return getSession().then((hashedsess) => {
      let sessionSaved = false;
      const oldEnd = res.end;
      //  Proxy res.end
      res.end = function resEndProxy(...args) {
        //  save session to store if there are changes (and there is a session)
        const saveSession = () => {
          if (req.session) {
            if (hash(req.session) !== hashedsess) {
              sessionSaved = true;
              return req.session.save();
            }
            //  Touch: extend session time despite no modification
            if (req.session.cookie.maxAge && touchAfter >= 0) {
              const minuteSinceTouched = (
                req.session.cookie.maxAge
                - (req.session.cookie.expires - new Date())
              );
              if ((minuteSinceTouched < touchAfter)) {
                return Promise.resolve();
              }
              return req.session.touch();
            }
          }
          return Promise.resolve();
        };

        return saveSession()
          .then(() => {
            if (
              (req.cookies[name] !== req.sessionId || sessionSaved || rollingSession)
              && req.session
            ) {
              res.setHeader('Set-Cookie', req.session.cookie.serialize(name, req.sessionId));
            }

            oldEnd.apply(this, args);
          });
      };

      return handler(req, res);
    });
  };
};

const useSession = (req, res, opts) => {
  //  add req cookie
  if (!req) return;
  if (!res) {
    throw new TypeError('Res not found! If you are passing handler, use the default import.');
  }
  req.cookies = req.cookies || parseCookie(req.headers.cookie);
  // eslint-disable-next-line consistent-return
  return session(() => null, opts)(req, res);
};

module.exports = session;
module.exports.Store = Store;
module.exports.Cookie = Cookie;
module.exports.Session = Session;
module.exports.MemoryStore = MemoryStore;
module.exports.useSession = useSession;

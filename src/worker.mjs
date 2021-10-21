// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
    async fetch(request, env) {
        try {
            return handleRequest(request, env);
        } catch (err) {
            return new Response(err.stack, { status: 500 });
        }
    }
}

const redirect_uri = '';
const scope = 'repo,user';
const oauthProvider = 'github';

function dec2hex (dec) {
    return dec.toString(16).padStart(2, "0")
}

// generateId :: Integer -> String
function generateId (len) {
    const arr = new Uint8Array((len || 40) / 2)
    crypto.getRandomValues(arr)
    return Array.from(arr, dec2hex).join('');
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Max-Age': '86400',
  "Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Origin",
};

async function handleRequest(request, env) {
    // Get the client's IP address for use with the rate limiter.
    const ip = request.headers.get("CF-Connecting-IP");
    const origin = request.headers.get('origin');
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: CORS_HEADERS,
        });
    } else if (pathname.startsWith("/auth") && request.method === "GET") {
        return Response.redirect(
          `https://github.com/login/oauth/authorize?client_id=${env.client_id}&&scope=${scope}&&redirect_uri=${redirect_uri}&&state=${generateId(32)}`,
          302
        );
    } else if (pathname.startsWith("/callback") && request.method === "GET") {
        // handle auth
        try {
            // const { code } = await request.json();
            const code = searchParams.get('code');
            const response = await fetch("https://github.com/login/oauth/access_token", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "user-agent": "cloudflare-worker-github-oauth",
                    accept: "application/json",
                },
                body: JSON.stringify({ client_id: env.client_id, client_secret: env.client_secret, code, grant_type: 'authorization_code', scope }),
                }
            );
            
            const result = await response.json();
            
            const headers = {
            "Access-Control-Allow-Origin": "*",
            };
            let mess = 'success'; let content;
        
            if (result.error) {
                mess = 'error';
                content = result.error;
                return new Response(JSON.stringify(result), { status: 401, headers });
            } else {
                content = {token: result.access_token, provider: oauthProvider};
            }
        
            
        
            const script = `
                <script>
                    (function() {
                        function recieveMessage(e) {
                            console.log("recieveMessage %o", e)
                            if (!e.origin.match(${JSON.stringify(env.originPattern)})) {
                                console.log('Invalid origin: %s', e.origin);
                                return;
                            }
                            // send message to main window with da app
                            window.opener.postMessage(
                            'authorization:${oauthProvider}:${mess}:${JSON.stringify(content)}',
                            e.origin
                            )
                        }
                        window.addEventListener("message", recieveMessage, false)
                        // Start handshare with parent
                        console.log("Sending message: %o", "${oauthProvider}")
                        window.opener.postMessage("authorizing:${oauthProvider}", "*")
                    })()
                </script>`;
        
            return new Response(script, {
                headers: {
                    "content-type": "text/html;charset=UTF-8",
                },
            });
        } catch (error) {
          console.log(error);
          return new Response(error.message, {status: 500});
        }
    } else if(pathname.startsWith("/contact") && request.method === 'POST') {
      if (!(origin && origin.match(env.originPattern))) {
        return new Response('Access Denied', {status: 403});
      }

      try {

        /*
        Un-comment to enable Rate limiting

        // Set up our rate limiter client.
        const limiterId = env.limiters.idFromName(ip);
        const limiter = new RateLimiterClient(
            () => env.limiters.get(limiterId),
            err => new Response(err.stack, { status: 500 }));
        
        if (!limiter.checkLimit()) {
            return new Response(JSON.stringify({
                error: "Your IP is being rate-limited, please try again later."
            }), { status: 403 });
        }

        */

        const id = crypto.randomUUID();
        const body = await request.json();
        const value = {...body, time: new Date().toISOString()};

        // storing in KV with auto expiry of 2 days
        await env.CONTACT.put(id, JSON.stringify(value), {expirationTtl: 2*24*60*60});
        return new Response(id, {status: 200, headers: CORS_HEADERS});
      } catch (err) {
        return new Response(err.stack, {status: 500});
      }
      
    } else {
      return new Response("Not allowed", {status: 405});
    }
}

// =======================================================================================
// The RateLimiter Durable Object class.

// RateLimiter implements a Durable Object that tracks the frequency of messages from a particular
// source and decides when messages should be dropped because the source is sending too many
// messages.
//
// We utilize this in ChatRoom, above, to apply a per-IP-address rate limit. These limits are
// global, i.e. they apply across all chat rooms, so if a user spams one chat room, they will find
// themselves rate limited in all other chat rooms simultaneously.
export class RateLimiter {
    constructor(controller, env) {
      // Timestamp at which this IP will next be allowed to send a message. Start in the distant
      // past, i.e. the IP can send a message now.
      this.nextAllowedTime = 0;
    }
  
    // Our protocol is: POST when the IP performs an action, or GET to simply read the current limit.
    // Either way, the result is the number of seconds to wait before allowing the IP to perform its
    // next action.
    async fetch(request) {
      return await handleErrors(request, async () => {
        let now = Date.now() / 1000;
  
        this.nextAllowedTime = Math.max(now, this.nextAllowedTime) + 30;
  
        // Return the number of seconds that the client needs to wait.
        let cooldown = Math.max(0, this.nextAllowedTime - now);
        return new Response(cooldown);
      })
    }
}

// RateLimiterClient implements rate limiting logic on the caller's side.
class RateLimiterClient {
    // The constructor takes two functions:
    // * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
    //   the limit. This may be called multiple times as needed to reconnect, if the connection is
    //   lost.
    // * reportError(err) is called when something goes wrong and the rate limiter is broken. It
    //   should probably disconnect the client, so that they can reconnect and start over.
    constructor(getLimiterStub, reportError) {
      this.getLimiterStub = getLimiterStub;
      this.reportError = reportError;
  
      // Call the callback to get the initial stub.
      this.limiter = getLimiterStub();
  
      // When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
      // false.
      this.inCooldown = false;
    }
  
    // Call checkLimit() when a message is received to decide if it should be blocked due to the
    // rate limit. Returns `true` if the message should be accepted, `false` to reject.
    checkLimit() {
      if (this.inCooldown) {
        return false;
      }
      this.inCooldown = true;
      this.callLimiter();
      return true;
    }
  
    // callLimiter() is an internal method which talks to the rate limiter.
    async callLimiter() {
      try {
        let response;
        try {
          // Currently, fetch() needs a valid URL even though it's not actually going to the
          // internet. We may loosen this in the future to accept an arbitrary string. But for now,
          // we have to provide a dummy URL that will be ignored at the other end anyway.
          response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
        } catch (err) {
          // `fetch()` threw an exception. This is probably because the limiter has been
          // disconnected. Stubs implement E-order semantics, meaning that calls to the same stub
          // are delivered to the remote object in order, until the stub becomes disconnected, after
          // which point all further calls fail. This guarantee makes a lot of complex interaction
          // patterns easier, but it means we must be prepared for the occasional disconnect, as
          // networks are inherently unreliable.
          //
          // Anyway, get a new limiter and try again. If it fails again, something else is probably
          // wrong.
          this.limiter = this.getLimiterStub();
          response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
        }
  
        // The response indicates how long we want to pause before accepting more requests.
        let cooldown = +(await response.text());
        await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
  
        // Done waiting.
        this.inCooldown = false;
      } catch (err) {
        this.reportError(err);
      }
    }
  }
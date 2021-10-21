# Cloudflare Github Oauth with Form handling

## Features
- Cloudflare worker for Oauth integration for netlify-cms
- Contact form handling
- Rate limiting request based on IP

This is an External Oauth client for [netlify-cms](https://www.netlifycms.org/docs/backends-overview/) with cloud form save.

GitHub requires a server for authentication and Netlify provides this server only for sites deployed to it.


### Installation

***Create Oauth App***
Information is available on the [Github Developer Documentation](https://developer.github.com/apps/building-integrations/setting-up-and-registering-oauth-apps/registering-oauth-apps/). Fill out the fields however you like, except for ***authorization callback URL***. This is where Github will send your callback after a user has authenticated, and should be https://your-worker.workers.dev/callback for use with this repo.

### Config

Put your website origin (can be regex eg. *.pages.dev) in wrangler.toml file to expose it as env variable

Client ID & Client Secret: After registering your Oauth app, you will be able to get your client id and client secret on the next page.

Put client_id and client_secret as [secrets](https://developers.cloudflare.com/workers/platform/environment-variables#adding-secrets-via-wrangler) in your clourflare worker.

### CMS Config
You also need to add `base_url` to the backend section of your netlify-cms's config file. `base_url` is the live URL of this repo with no trailing slashes.

```yaml
backend:
  name: github
  repo: user/repo   # Path to your Github repository
  branch: master    # Branch to update
  base_url: https://your-worker.workers.dev # Path to ext auth provider
```

### Deployment

You can deploy manually or through warngler cli

```bash
    wrangler publish
```


### Conatct form

Worker will listen to /contact url for POST method and store all messages in KV with auto-expiry of 2 days. 

You can trigger a cron job to automatically read all messages from KV and send it as single/multiple Email through an Email API provider like sendgrid.com


### ***Bonus:*** Rate-limit

The contact form url can be abused to spam request since there is no authentication.
Through Durable objects you can allow each IP address to post 1 request per 30s. You can configure the duration in wrangler.toml as an env variable.

```bash
wrangler publish --new-class RateLimiter
```

> Note - Using Durable object requires joining their beta program
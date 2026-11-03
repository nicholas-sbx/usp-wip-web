# USPWIP Web

The guest side of [USPWIP Desktop](https://github.com/nicholas-sbx/usp-wip-desktop): the join page guests open from a room link. Plain static files in `public/`, no build step.

## Hosting (Cloudflare Pages)

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, pick this repository, then:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `public` |

Every push to `main` then deploys, and other branches get preview URLs. `public/_headers` adds response headers Cloudflare serves with every page (anti-framing, no MIME sniffing, no referrer, long caching for the versioned PeerJS file).

Then point the desktop app's room links at the site: in usp-wip-desktop, set the Actions variable `USPWIP_WEB_BASE_URL` to the site's URL (e.g. `https://<project>.pages.dev`, no trailing `/public`) and release a new version.

## Local development

Serve the repository root on port 5500 (e.g. VS Code Live Server, or `python3 -m http.server 5500`): development builds of the desktop app link to `http://localhost:5500/public/join#<room>`. Chrome or Edge is needed (document picture-in-picture).

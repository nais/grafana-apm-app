# Documentation / Issue: Fixing Faro Source Maps Authentication & CORS Wall

## Description
When an exception occurs in production, the Grafana Alloy faro receiver attempts to fetch the corresponding `.map` file from the origin host of the JavaScript bundle to de-obfuscate the stack trace. 

However, if an application requires authentication (e.g. internally hosted apps under Azure AD / IDporten), Alloy’s anonymous download requests are blocked by a login wall (resulting in a 302 redirect or 401 Unauthorized), leaving the stack trace minified in Loki.

We need to establish platform guidelines and configurations to bypass this auth wall by serving assets from `cdn.nav.no`.

## Resolution Plan
1.  **Serve Source Maps from CDN**:
    *   Require application teams to upload their production JavaScript bundles and `.map` files to **`cdn.nav.no`** during their CI/CD build step.
2.  **App Configuration**:
    *   Configure the application's bundler (e.g. Next.js `assetPrefix` or Webpack `publicPath`) to point directly to the CDN:
        ```javascript
        module.exports = {
          assetPrefix: 'https://cdn.nav.no/my-app/',
        };
        ```
    *   This ensures the browser loads JavaScript resources from the CDN, and the resulting stack trace logs contain `cdn.nav.no` asset URLs.
3.  **Alloy Configuration**:
    *   Ensure Grafana Alloy's `faro.receiver` is configured to download source maps from the CDN:
        ```hcl
        faro.receiver "default" {
          sourcemaps {
            download = true
            download_from_origins = [
              "https://cdn.nav.no",
            ]
          }
        }
        ```
    *   Since `cdn.nav.no` has public access and CORS configured correctly, Alloy will be able to download map files securely, returning fully de-obfuscated stack traces to Loki.

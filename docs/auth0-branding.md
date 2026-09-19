# Auth0 Universal Login — branding & copy (dashboard source of truth)

The login page is **tenant-side configuration**, not repo code: nothing in this
repository renders it. This file records the values so the dashboard can be
rebuilt and reviewed like code. Tenant `dev-zv5urb33g0msy7bc.eu.auth0.com` behind
the custom domain **`auth.konnektr.io`**; app client `jbMyX3scNHkECOF1lNJTOovXe8fOBmiq`.

Dashboard: **Branding → Universal Login → Customization Options** (no-code editor)
and **Branding → Universal Login → Advanced Options → Custom Text**.

## Why the custom domain (and the one rule that breaks everything)

Tokens obtained through a custom domain carry `iss: https://auth.konnektr.io/`.
`backend/app/auth.py` builds the expected issuer as `https://<AUTH0_DOMAIN>/`, so:

- the SPA's baked default (`frontend/src/lib/auth.ts`) and `AUTH0_DOMAIN`
  (k8s env / `backend/app/config.py`) must **both** be `auth.konnektr.io`;
- the image and the env value must ship **together** — one without the other
  rejects every token (401 on every protected call);
- the M2M helpers (`backend/scripts/kiseki_m2m.py`) must mint against the same
  host, or agent writes fail validation;
- Allowed Callback/Logout URLs + Web Origins stay the **app** origins
  (`https://kiseki.konnektr.io`, `http://localhost:5173`). A custom domain is an
  issuer, not a callback — do not add it there.

Sessions created on the raw tenant host stop being valid at the switch: users
sign in once more. `sub` values are unchanged, so User twins, `hasCrew` edges,
ACLs and follows are untouched.

Social connections: the custom domain must be registered with each IdP
(`https://auth.konnektr.io/login/callback` in the Google/Microsoft app), and
Auth0 **developer keys cannot be used with a custom domain** — these connections
already run on the tenant's own OAuth apps.

## Theme (Branding → Universal Login → Customization Options)

```json
{
  "colors": {
    "primary_button": "#9f1239",
    "primary_button_label": "#fff7ed",
    "secondary_button_border": "#e7e5e4",
    "secondary_button_label": "#1c1917",
    "base_focus_color": "#9f1239",
    "base_hover_color": "#881337",
    "links_focused_components": "#9f1239",
    "header": "#1c1917",
    "body_text": "#1c1917",
    "widget_background": "#ffffff",
    "widget_border": "#e7e5e4",
    "input_labels_placeholders": "#78716c",
    "input_filled_text": "#1c1917",
    "input_border": "#e7e5e4",
    "input_background": "#ffffff",
    "icons": "#78716c",
    "error": "#b91c1c",
    "success": "#15803d",
    "captcha_widget_theme": "light",
    "read_only_background": "#f5f5f4"
  },
  "fonts": {
    "font_url": "@url:`https://cdn.jsdelivr.net/fontsource/fonts/inter:vf@latest/latin-wght-normal.woff2`",
    "reference_text_size": 16,
    "title": { "bold": true, "size": 175 },
    "subtitle": { "bold": false, "size": 87.5 },
    "body_text": { "bold": false, "size": 87.5 },
    "buttons_text": { "bold": true, "size": 100 },
    "input_labels": { "bold": true, "size": 100 },
    "links": { "bold": true, "size": 87.5 },
    "links_style": "normal"
  },
  "borders": {
    "button_border_weight": 1,
    "buttons_style": "rounded",
    "button_border_radius": 6,
    "input_border_weight": 1,
    "inputs_style": "rounded",
    "input_border_radius": 6,
    "widget_corner_radius": 12,
    "widget_border_weight": 0,
    "show_widget_shadow": true
  },
  "widget": {
    "logo_position": "center",
    "logo_url": "@url:`https://kiseki.konnektr.io/logo-mark-transparent.png`",
    "logo_height": 52,
    "header_text_alignment": "center",
    "social_buttons_layout": "bottom"
  },
  "page_background": {
    "page_layout": "left",
    "background_color": "#fafaf9",
    "background_image_url": "https://kiseki.konnektr.io/marketing/login-machu-picchu.jpg"
  },
  "displayName": "Kiseki",
  "identifiers": {
    "login_display": "unified",
    "otp_autocomplete": true,
    "phone_display": { "masking": "mask_digits", "formatting": "international" }
  }
}
```

Every colour is a `--trip-*` design token from `frontend/src/index.css`, so the
login page and the app share one palette. Deliberate choices:

- **`inter:vf@…latin-wght-normal`** — a *variable* font file. The editor accepts
  one URL; the plain `latin-400-normal` file makes every `bold: true` element
  render as browser-synthesised faux bold. Needs CORS (jsDelivr sends `*`).
- **`social_buttons_layout: "bottom"`** — email + the rose CTA lead; Google /
  Microsoft sit below the "Or" rule. On top, three outline buttons pushed the
  brand CTA down and the Microsoft label wrapped on mobile.
- **`widget_border_weight: 0`** — on a photograph the hairline border is
  invisible anyway; the shadow defines the card.
- **`page_layout: "left"`** — the card covers the shaded switchback slope, the
  citadel and the ridgelines stay visible on the right.
- **Background** is `marketing/login-machu-picchu.jpg` (see
  `frontend/public/marketing/CREDITS.md`): rights-free Chile–Peru imagery,
  graded and re-cropped to 16:9. Auth0 wants a JPEG ≥2000px wide; this is
  2392×1344. Swapping it means editing this file *and* the dashboard.

**Trap:** the prompt `<img>` keeps `src` pointing at the tenant's *default*
branding logo (`https://konnektr.io/konnektr.svg` — a dead host) and the theme's
logo is applied over it with CSS `content: url(...)`. Point the tenant branding
logo at a live URL as well; otherwise a CSS change leaves a broken image.

## Custom text (Advanced Options → Custom Text → prompt `login`, screen `login`)

```json
{
  "pageTitle": "Sign in · Kiseki",
  "title": "Welcome back",
  "description": "Sign in to keep your trips moving.",
  "buttonText": "Continue",
  "separatorText": "Or",
  "federatedConnectionButtonText": "Continue with ${connectionName}",
  "emailPlaceholder": "you@example.com",
  "passwordPlaceholder": "Password",
  "forgotPasswordText": "Forgot password?",
  "footerText": "New to Kiseki?",
  "footerLinkText": "Create an account",
  "signupActionLinkText": "${footerLinkText}",
  "signupActionText": "${footerText}",
  "logoAltText": "Kiseki"
}
```

Default copy is `Welcome` / `Log in to Konnektr to continue to Kiseki.` — the
tenant's display name leaks the platform brand into Kiseki's login.

**Caveat:** the no-code theme is tenant-wide. Every application on this tenant
gets this logo, photo and copy. Per-app branding needs **Page Templates (ACUL)**
(`auth0 universal-login customize`, Management API, requires a custom domain —
which the tenant now has). Page templates can branch on `application.id`/`name`,
add a scrim over the photo (the no-code editor has no overlay control), load
Bebas Neue / Oswald through `--font-family`, and drop the Auth0 badge.

## Verifying a change

The editor's **Try** preview shows the real prompt. After saving, verify live:
open `https://kiseki.konnektr.io`, click **Sign in**, and confirm the login page
is served from `auth.konnektr.io/u/login/identifier` with the new background and
copy. No release is needed for a theme change; a change to `AUTH0_DOMAIN` is a
code + k8s change and does need one.

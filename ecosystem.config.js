module.exports = {
  apps: [
    {
      name: 'wol-interceptor',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: '9494',
        TARGET_HOST: '',
        TARGET_PORT: '443',
        TARGET_MAC: '',
        TARGET_LABEL: 'device',
        WOL_BROADCAST: '255.255.255.255',

        // OIDC — every var is required at boot. The IdP discovery doc lives at
        // <issuer>/.well-known/openid-configuration; point OIDC_ISSUER_URL at
        // the issuer (NOT the discovery URL itself).
        OIDC_ISSUER_URL: '',          // e.g. https://login.microsoftonline.com/<tenant>/v2.0
        OIDC_CLIENT_ID: '',
        OIDC_CLIENT_SECRET: '',
        OIDC_REDIRECT_URI: '',
        OIDC_ALLOWED_GROUP: '',
        OIDC_GROUP_CLAIM: 'groups',   // override to 'roles' for Entra app roles
        OIDC_SCOPES: 'openid profile email',

        // Session cookie — SESSION_SECRET MUST be a long random string;
        // rotate it to invalidate all live sessions.
        SESSION_SECRET: '',
        COOKIE_SECURE: 'true',
      },
    },
  ],
};

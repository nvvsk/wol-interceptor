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
      },
    },
  ],
};

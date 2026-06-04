const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withNetworkSecurityConfig(config) {
  // Copy xml file to android res/xml
  config = withDangerousMod(config, [
    'android',
    (config) => {
      const src = path.join(config.modRequest.projectRoot, 'network_security_config.xml');
      const dest = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/res/xml/network_security_config.xml'
      );
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return config;
    },
  ]);

  // Add android:networkSecurityConfig to AndroidManifest <application>
  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return config;
  });

  return config;
}

module.exports = withNetworkSecurityConfig;

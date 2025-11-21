const path = require('path');
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require('nativewind/metro');

const config = withNativeWind(getDefaultConfig(__dirname), { input: './global.css' });

config.resolver = config.resolver || {};
const virtualEnvPath = path.resolve(__dirname, 'scripts/expo-virtual-env.js');
const terminalReporterPath = path.resolve(
  __dirname,
  'node_modules/metro/private/lib/TerminalReporter.js'
);

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  'expo/virtual/env': virtualEnvPath,
  'expo/virtual/env.js': virtualEnvPath,
  'metro/src/lib/TerminalReporter': terminalReporterPath,
};

module.exports = config;

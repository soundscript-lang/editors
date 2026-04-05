export type ExtensionRuntimeMode = 'development' | 'production' | 'test';

export function resolveServerRuntimeMode(
  extensionMode: ExtensionRuntimeMode,
  forceDevelopmentCli: boolean,
): 'development' | 'production' {
  if (forceDevelopmentCli) {
    return 'development';
  }

  return extensionMode === 'production' ? 'production' : 'development';
}

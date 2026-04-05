export interface ConfigurationLike {
  get<T>(section: string, defaultValue: T): T;
}

export interface SoundscriptCliLaunch {
  argsPrefix: string[];
  command: string;
}

export interface SoundscriptTypeScriptPluginConfiguration {
  soundscriptArgsPrefix: string[];
  soundscriptCommand?: string;
  stsScriptKind: 'ts' | 'tsx';
}

export const SOUNDSCRIPT_TSSERVER_PLUGIN_NAME = '@soundscript/tsserver-plugin';

export function readTypeScriptPluginConfiguration(
  configuration: ConfigurationLike,
  cliLaunch?: SoundscriptCliLaunch,
): SoundscriptTypeScriptPluginConfiguration {
  return {
    soundscriptArgsPrefix: cliLaunch?.argsPrefix ?? [],
    soundscriptCommand: cliLaunch?.command,
    stsScriptKind: configuration.get('tsserver.stsScriptKind', 'ts'),
  };
}

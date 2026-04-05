export interface ConfigurationLike {
  get<T>(section: string, defaultValue: T): T;
}

export interface DisposableLike {
  dispose(): void;
}

export function isFormattingEnabled(configuration: ConfigurationLike): boolean {
  return configuration.get<boolean>('format.enable', true);
}

export function syncFormattingRegistration(
  currentRegistration: DisposableLike | undefined,
  formattingEnabled: boolean,
  register: () => DisposableLike,
): DisposableLike | undefined {
  if (formattingEnabled) {
    return currentRegistration ?? register();
  }

  currentRegistration?.dispose();
  return undefined;
}

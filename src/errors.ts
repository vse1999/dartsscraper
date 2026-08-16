export class DartsOrakelError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class PlayerNotFoundError extends DartsOrakelError {
  public constructor(name: string) {
    super(`No DartsOrakel player matched ${JSON.stringify(name)}.`);
  }
}

export class PlayerAmbiguousError extends DartsOrakelError {
  public constructor(name: string, matches: readonly string[]) {
    super(`Player name ${JSON.stringify(name)} is ambiguous: ${matches.join(", ")}.`);
  }
}

export class DartsOrakelRequestError extends DartsOrakelError {
  public readonly url: string;
  public readonly status: number | undefined;
  public readonly retryable: boolean;

  public constructor(
    message: string,
    details: {
      url: string;
      status?: number;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.url = details.url;
    this.status = details.status;
    this.retryable = details.retryable;
  }
}

export class DartsOrakelStructureChangedError extends DartsOrakelError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export class InsufficientMatchDataError extends DartsOrakelError {
  public readonly requested: number;
  public readonly available: number;

  public constructor(requested: number, available: number) {
    super(`DartsOrakel returned no completed matches; requested ${requested}, available ${available}.`);
    this.requested = requested;
    this.available = available;
  }
}

export class ModusSourceUnavailableError extends Error {
  public readonly failures: readonly string[];

  public constructor(date: string, failures: readonly string[]) {
    super(`No configured MODUS source could provide fixtures for ${date}. ${failures.join(" ")}`);
    this.name = new.target.name;
    this.failures = failures;
  }
}

export class ModusHistoryUnavailableError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

export class AgentLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class OllamaRequestError extends Error {
  public readonly status: number | undefined;

  public constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
  }
}

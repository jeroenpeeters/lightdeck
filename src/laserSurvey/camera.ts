/**
 * The client of the camera app (`android-camera/`): a phone that takes a photo or films a clip
 * when asked over HTTP, with the exposure held by hand so that every shot of a survey is
 * comparable.
 *
 * The app answers (all on port 9020):
 *   GET  /status                       what the camera can do and is set to, JSON
 *   POST /settings?iso=&exposureMs=&focus=&width=   sets any of them, answers like /status
 *   POST /photo                        a JPEG; the header `x-lightdeck-settings` has what was used
 *   POST /clip?seconds=                an MP4, with the same header
 * A failure is a status of 4xx or 5xx with the reason as plain text.
 */

export interface CameraStatus {
  /** True when the camera is open and a shot can be taken. */
  ready: boolean;
  /** What is wrong when it is not ready. */
  problem?: string;
  /** False when the phone cannot set the exposure by hand: the photos are then auto exposed. */
  manualSensor?: boolean;
  iso?: number;
  exposureMs?: number;
  /** In diopters: 0 is infinity, 2 is half a metre. */
  focus?: number;
  /** The range the phone accepts, `[min, max]`. */
  isoRange?: [number, number];
  exposureRangeMs?: [number, number];
  /** The nearest the lens can focus, in diopters. */
  minFocus?: number;
  still?: { width: number; height: number };
  video?: { width: number; height: number };
  [key: string]: unknown;
}

export interface CameraSettings {
  iso?: number;
  exposureMs?: number;
  focus?: number;
  /** Width of the photos: the largest size the camera has that is not wider than this. */
  width?: number;
}

export interface Capture {
  data: Uint8Array;
  /** What the phone says it used for this shot. */
  settings: Record<string, unknown>;
}

/** What the survey needs of a camera: the HTTP client below, or a fake in a test. */
export interface Camera {
  photo(): Promise<Capture>;
  clip(seconds: number): Promise<Capture>;
}

export class CameraError extends Error {}

export type FetchLike = typeof fetch;

export const SETTINGS_HEADER = 'x-lightdeck-settings';

/** `192.168.68.102` or `192.168.68.102:9020` or a full `http://` address, as a base URL. */
export function cameraUrl(text: string, defaultPort = 9020): string {
  const trimmed = text.trim().replace(/\/+$/, '');
  if (trimmed === '')
    throw new CameraError('say where the camera app is, for example 192.168.68.102');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CameraError(`"${text}" is not an address`);
  }
  if (url.port === '') url.port = String(defaultPort);
  return `${url.protocol}//${url.host}`;
}

export class HttpCamera implements Camera {
  private readonly base: string;
  private readonly fetchFn: FetchLike;

  constructor(address: string, fetchFn: FetchLike = fetch) {
    this.base = cameraUrl(address);
    this.fetchFn = fetchFn;
  }

  get url(): string {
    return this.base;
  }

  async status(): Promise<CameraStatus> {
    return this.json('/status', 'GET');
  }

  async configure(settings: CameraSettings): Promise<CameraStatus> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return this.json(`/settings?${query}`, 'POST');
  }

  async photo(): Promise<Capture> {
    return this.capture('/photo', 30_000);
  }

  async clip(seconds: number): Promise<Capture> {
    if (!(seconds > 0)) throw new CameraError('a clip lasts a positive number of seconds');
    return this.capture(`/clip?seconds=${seconds}`, seconds * 1000 + 60_000);
  }

  private async json(path: string, method: string): Promise<CameraStatus> {
    const response = await this.request(path, method, 10_000);
    try {
      return (await response.json()) as CameraStatus;
    } catch {
      throw new CameraError(`${this.base}${path} did not answer with JSON`);
    }
  }

  private async capture(path: string, timeoutMs: number): Promise<Capture> {
    const response = await this.request(path, 'POST', timeoutMs);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length === 0) throw new CameraError(`${path}: the camera sent no data`);
    let settings: Record<string, unknown> = {};
    const header = response.headers.get(SETTINGS_HEADER);
    if (header) {
      try {
        settings = JSON.parse(header) as Record<string, unknown>;
      } catch {
        settings = { unreadable: header };
      }
    }
    return { data, settings };
  }

  private async request(path: string, method: string, timeoutMs: number): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new CameraError(
        `cannot reach the camera app at ${this.base} (${why}). Is it open on the phone, on the same wifi?`,
      );
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim();
      throw new CameraError(`camera app: ${text || `HTTP ${response.status}`}`);
    }
    return response;
  }
}

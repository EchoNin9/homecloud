export class HomeCloudError extends Error {
  /** HTTP status, or 0 for network failures / client-side timeouts. */
  readonly status: number;
  /** Contract error code (`{"error": code}`), or a client code: network_error, timeout, bad_response, http_<status>. */
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.name = 'HomeCloudError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, HomeCloudError.prototype);
  }
}

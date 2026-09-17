/** Small typed error so route handlers can `throw` and one Express error
 * middleware turns it into the right status code + `{ error: code }` body. */
export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

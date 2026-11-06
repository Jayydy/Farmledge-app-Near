/** Shape of every error response from the API. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

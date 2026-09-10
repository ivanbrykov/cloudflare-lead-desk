/**
 * Test-only worker entry for the intake open-stream cancellation regression.
 *
 * Miniflare does not propagate cancellation of a Node-created request body
 * stream back to the Node side, so the regression builds the oversized
 * stream INSIDE the worker (the same technique the external verifier uses)
 * and delegates everything else to the real exported worker unchanged.
 *
 * `POST /__intake_cancellation` enqueues a single 65,537-byte chunk into a
 * stream that stays open (it never closes on its own), forwards it to the
 * real worker's `POST /v1/intakes`, and reports whether the worker
 * cancelled the stream and whether the reader lock was released.
 */
import actual from '../src/worker-global';

const PROBE_PATH = '/__intake_cancellation';

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === PROBE_PATH) {
      let cancelled = false;
      // highWaterMark 0 plus one oversized chunk: the stream is still open
      // when the worker reads it, so only an explicit cancel() ends it.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65_537));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      // The duplex mode is not modelled by the RequestInit type here; the
      // runtime supports it.
      const intakeRequest = new Request('https://intake-cancellation.test/v1/intakes', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
        duplex: 'half',
      } as RequestInit);
      const response = await actual.fetch(intakeRequest);
      const responseBody = await response.text();
      return Response.json({
        status: response.status,
        responseBody,
        cancelled,
        locked: body.locked,
      });
    }
    return actual.fetch(request);
  },
};

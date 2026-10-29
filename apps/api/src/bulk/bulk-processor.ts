import { Injectable } from '@nestjs/common';

/**
 * Runs a bulk job's rows through the firm search (P6-D5). This is the stub Task 3 fills in: `start` is fire-and-forget
 * and never throws, so the upload can call it once its transaction has committed.
 */
@Injectable()
export class BulkProcessor {
  start(jobId: string): void {
    void jobId;
  }
}

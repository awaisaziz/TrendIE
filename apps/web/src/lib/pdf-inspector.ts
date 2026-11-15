import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { inspectPdf } from '../../../../services/pdf-inspection/inspect.mjs';
import type { ProposalView } from '@/lib/types';

export const PDF_MAX_BYTES = 5_000_000;
export const PDF_MAX_PAGES = 20;
export const PDF_MAX_TEXT_CHARS = 100_000;
export const PDF_INSPECTION_TEXT_LIMIT = 20_000;
const PDF_REQUEST_OVERHEAD_BYTES = 64 * 1024;
const INSPECTOR_TIMEOUT_MS = 5_000;

export type PdfInspection = {
  intentId: string;
  source: string;
  text: string;
  pageCount: number;
  extractedChars: number;
  truncated: boolean;
  limitations: string[];
};

export class PdfUploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'PdfUploadError';
  }
}

export function fitPdfInspectionText(proposal: ProposalView, source: string, text: string): { text: string; truncated: boolean } {
  const points = Array.from(text);
  let low = 0;
  let high = Math.min(points.length, PDF_INSPECTION_TEXT_LIMIT);
  let best = 0;
  const encoder = new TextEncoder();
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = points.slice(0, middle).join('');
    const body = JSON.stringify({ proposal, inspectionText: { source, text: candidate } });
    if (encoder.encode(body).byteLength <= 60 * 1024) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { text: points.slice(0, best).join(''), truncated: best < points.length };
}

type ExtractedDocument = {
  pages: Array<{ page: number; text: string }>;
  pageCount: number;
  textChars: number;
  limitations: string[];
};

export function isSameOriginMultipartWrite(request: Request): boolean {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get('origin');
  if (contentType !== 'multipart/form-data' || !origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function extractPdfUpload(
  request: Request,
  inspect: (filePath: string) => Promise<unknown> = runPdfInspector,
): Promise<PdfInspection> {
  if (!isSameOriginMultipartWrite(request)) {
    throw new PdfUploadError(403, 'A same-origin PDF upload is required.');
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  const requestLimit = PDF_MAX_BYTES + PDF_REQUEST_OVERHEAD_BYTES;
  if (Number.isFinite(contentLength) && contentLength > requestLimit) {
    throw new PdfUploadError(413, 'PDF upload exceeds the 5 MB limit.');
  }

  const body = await readBoundedRequest(request, requestLimit);
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw new PdfUploadError(400, 'Upload must contain one valid PDF file.');
  }

  if ([...form.keys()].some((key) => key !== 'file' && key !== 'intentId') ||
      form.getAll('file').length !== 1 || form.getAll('intentId').length !== 1) {
    throw new PdfUploadError(400, 'Upload must contain one PDF file and one authorization ID.');
  }
  const intentId = form.get('intentId');
  if (typeof intentId !== 'string' || intentId.trim() !== intentId || intentId.length < 1 || intentId.length > 64) {
    throw new PdfUploadError(400, 'A valid authorization ID is required.');
  }
  const uploaded = form.get('file');
  if (!(uploaded instanceof File)) throw new PdfUploadError(400, 'Upload must contain one PDF file.');
  if (uploaded.size === 0) throw new PdfUploadError(400, 'The PDF file is empty.');
  if (uploaded.size > PDF_MAX_BYTES) throw new PdfUploadError(413, 'PDF upload exceeds the 5 MB limit.');
  if (uploaded.name.length > 255 || !uploaded.name.toLowerCase().endsWith('.pdf')) {
    throw new PdfUploadError(400, 'Choose a file with a .pdf extension.');
  }
  if (uploaded.type && uploaded.type !== 'application/pdf') {
    throw new PdfUploadError(400, 'The selected file must be a PDF.');
  }

  const bytes = Buffer.from(await uploaded.arrayBuffer());
  if (bytes.length > PDF_MAX_BYTES) throw new PdfUploadError(413, 'PDF upload exceeds the 5 MB limit.');
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new PdfUploadError(400, 'The uploaded file is not a valid PDF.');
  }

  const directory = await mkdtemp(join(tmpdir(), 'trendie-pdf-'));
  const filePath = join(directory, 'upload.pdf');
  try {
    await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    const extracted = await inspect(filePath);
    const normalized = validateExtractedDocument(extracted);
    const filename = uploaded.name.replaceAll('\\', '/').split('/').at(-1) ?? 'invoice.pdf';
    const source = `uploaded-pdf:${filename.replace(/[\r\n\0]/g, '').slice(0, 120) || 'invoice.pdf'}`;
    const extractedText = Array.from(normalized.text);
    return {
      intentId,
      source,
      text: extractedText.slice(0, PDF_INSPECTION_TEXT_LIMIT).join(''),
      pageCount: normalized.pageCount,
      extractedChars: normalized.textChars,
      truncated: extractedText.length > PDF_INSPECTION_TEXT_LIMIT,
      limitations: normalized.limitations,
    };
  } finally {
    // The source document is intentionally ephemeral, including on extractor errors.
    await rm(directory, { recursive: true, force: true });
  }
}

async function readBoundedRequest(request: Request, maxBytes: number): Promise<Buffer> {
  if (!request.body) throw new PdfUploadError(400, 'Upload body is empty.');
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PdfUploadError(413, 'PDF upload exceeds the 5 MB limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function runPdfInspector(filePath: string): Promise<unknown> {
  const serviceUrl = process.env.PDF_INSPECTION_URL?.trim();
  if (serviceUrl) {
    // Deployed on Vercel: the internal pdf-inspection service (bound via PDF_INSPECTION_URL) does the extraction.
    try {
      const base = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`;
      const response = await fetch(new URL('inspect', base), {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', accept: 'application/json' },
        body: new Uint8Array(await readFile(filePath)),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(INSPECTOR_TIMEOUT_MS * 2),
      });
      if (!response.ok) throw new Error('inspection service rejected the PDF');
      const length = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(length) && length > 1_000_000) throw new Error('inspection response too large');
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error('inspection response too large');
      return JSON.parse(text) as unknown;
    } catch {
      throw new PdfUploadError(422, 'PDF extraction failed or exceeded its resource limits. Encrypted and unsupported PDFs are rejected.');
    }
  }
  try {
    return await inspectPdf({
      path: basename(filePath),
      allowlistedRoot: dirname(filePath),
      python: process.env.PDF_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3'),
      timeoutMs: INSPECTOR_TIMEOUT_MS,
    });
  } catch {
    throw new PdfUploadError(422, 'PDF extraction failed or exceeded its resource limits. Encrypted and unsupported PDFs are rejected.');
  }
}

function validateExtractedDocument(value: unknown): ExtractedDocument & { text: string } {
  if (!isRecord(value) || !Array.isArray(value.pages) || !Array.isArray(value.limitations)) {
    throw new PdfUploadError(502, 'PDF extractor returned an invalid response.');
  }
  if (value.error) throw new PdfUploadError(422, 'PDF extraction failed. Encrypted, oversized, or unsupported PDFs are rejected.');
  const pageCount = value.pageCount;
  const textChars = value.textChars;
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 0 || pageCount > PDF_MAX_PAGES ||
      typeof textChars !== 'number' || !Number.isInteger(textChars) || textChars < 0 || textChars > PDF_MAX_TEXT_CHARS ||
      value.pages.length !== pageCount) {
    throw new PdfUploadError(422, 'PDF exceeds the 20 page or 100,000 extracted character limit.');
  }
  const pages: Array<{ page: number; text: string }> = [];
  for (const page of value.pages) {
    if (!isRecord(page) || !Number.isInteger(page.page) || typeof page.text !== 'string') {
      throw new PdfUploadError(502, 'PDF extractor returned an invalid page.');
    }
    pages.push({ page: page.page as number, text: page.text });
  }
  const text = pages.map((page) => page.text).join('\n');
  const extractedCharacterCount = pages.reduce((count, page) => count + Array.from(page.text).length, 0);
  if (extractedCharacterCount > PDF_MAX_TEXT_CHARS || extractedCharacterCount !== textChars) {
    throw new PdfUploadError(502, 'PDF extractor returned inconsistent text limits.');
  }
  return {
    pages,
    pageCount: pageCount as number,
    textChars: textChars as number,
    limitations: value.limitations.filter((limitation): limitation is string => typeof limitation === 'string').slice(0, 10),
    text,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import { FileUp, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { importFile, type SymbolDto } from '@/lib/api';

/**
 * Import bars from a file.
 *
 * Two formats, one parser (A63). MT5's "Export Bars" splits the stamp across `<DATE>` and `<TIME>`
 * and carries `<SPREAD>` in points; a generic export usually writes one datetime column and no
 * spread at all. The importer detects columns by NAME, so both go through the same reader and
 * neither can drift from the other.
 *
 * The broker offset is asked for, not guessed. MT5 files carry the broker's server wall-clock with
 * nothing in the file saying which zone that was — a GMT+2 broker's 00:00 bar is 22:00 UTC the day
 * before, and importing it as UTC shifts every bar by two hours in a way nothing downstream can
 * detect. The field is therefore prominent, and it defaults to 0 only for generic files, which are
 * conventionally UTC.
 *
 * Exness tick ZIPs are NOT offered. The importer exists and the endpoint accepts them, but no
 * export has ever reached this project (A12), and an option nobody can exercise is a claim the UI
 * cannot keep.
 */

type Format = 'mt5-csv' | 'generic-csv';

interface Outcome {
  readonly symbol: string;
  readonly rows: number;
  readonly inserted: number;
  readonly duplicates: number;
}

export function ImportDropZone({
  symbols,
  onImported,
}: {
  readonly symbols: readonly SymbolDto[];
  readonly onImported: () => void;
}): React.JSX.Element {
  const [symbol, setSymbol] = useState(symbols[0]?.symbol ?? '');
  const [format, setFormat] = useState<Format>('mt5-csv');
  const [offset, setOffset] = useState('0');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    setOutcome(null);

    try {
      const result = (await importFile({
        file,
        symbol,
        format,
        serverUtcOffsetMinutes: Number(offset) || 0,
      })) as unknown as Outcome;
      setOutcome(result);
      onImported();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="import-dropzone">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[0.65rem] uppercase tracking-wide text-muted">
            Into symbol
          </span>
          <select
            className={INPUT}
            value={symbol}
            onChange={(e) => {
              setSymbol(e.target.value);
            }}
            data-testid="import-symbol"
          >
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.symbol}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[0.65rem] uppercase tracking-wide text-muted">
            Format
          </span>
          <select
            className={INPUT}
            value={format}
            onChange={(e) => {
              const next = e.target.value as Format;
              setFormat(next);
              // Generic exports are conventionally UTC; MT5 files never are.
              if (next === 'generic-csv') setOffset('0');
            }}
            data-testid="import-format"
          >
            <option value="mt5-csv">MT5 &quot;Export Bars&quot;</option>
            <option value="generic-csv">Generic CSV</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[0.65rem] uppercase tracking-wide text-muted">
            Server offset (min)
          </span>
          <input
            type="number"
            step={15}
            className={INPUT}
            value={offset}
            onChange={(e) => {
              setOffset(e.target.value);
            }}
            data-testid="import-offset"
          />
        </label>
      </div>

      <p className="text-xs leading-relaxed text-muted">
        {format === 'mt5-csv' ? (
          <>
            MT5 writes the BROKER&apos;s wall clock and the file does not say which zone that was. A
            &quot;GMT+2&quot; server is <strong>120</strong>. Get this wrong and every bar is
            shifted by that much, silently.
          </>
        ) : (
          <>
            A date or datetime column plus open, high, low and close. Time, volume and spread are
            optional; timestamps are read as UTC unless you set an offset.
          </>
        )}
      </p>

      {/*
        The drop target is also a button. A drop-zone that cannot be reached from the keyboard is
        not an input, it is a decoration with a file picker hidden behind it.
      */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file !== undefined) void upload(file);
        }}
        disabled={busy}
        className={`flex w-full flex-col items-center gap-1 rounded border border-dashed p-6 text-xs transition-colors ${
          dragging ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted'
        } disabled:opacity-50`}
        data-testid="import-drop"
      >
        {busy ? <Loader2 className="size-5 animate-spin" /> : <FileUp className="size-5" />}
        {busy ? 'Reading the file…' : 'Drop a file here, or click to choose one'}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.txt,.tsv"
        className="hidden"
        data-testid="import-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) void upload(file);
          // Cleared so choosing the same file twice still fires a change.
          e.target.value = '';
        }}
      />

      {error !== null && (
        <p
          className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="import-error"
        >
          {error}
        </p>
      )}

      {outcome !== null && (
        <p
          className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200"
          data-testid="import-done"
        >
          {/*
            Duplicates are reported rather than hidden: re-importing an overlapping file is normal
            and inserting nothing is the CORRECT outcome, but silence there looks like a failure.
          */}
          {outcome.symbol}: read {outcome.rows.toLocaleString()} rows, stored{' '}
          {outcome.inserted.toLocaleString()} bars
          {outcome.duplicates > 0 &&
            `, skipped ${outcome.duplicates.toLocaleString()} already present`}
          .
        </p>
      )}
    </div>
  );
}

const INPUT =
  'h-8 w-full rounded border border-border bg-surface px-2 text-xs outline-none focus:border-primary';

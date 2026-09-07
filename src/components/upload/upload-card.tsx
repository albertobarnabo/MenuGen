"use client";

import { useCallback, useState } from "react";
import { ErrorCode, useDropzone, type FileRejection } from "react-dropzone";
import { CloudUploadIcon, FileDownIcon, FileSpreadsheetIcon, ListChecksIcon, ReplaceIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { ParseResult, ParseWarning } from "@/lib/types";
import { CSV_EXTENSIONS, ParseError, parseCsv, parseMenuFile } from "@/lib/parse";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { downloadBlob, pluralize } from "@/components/shared/format";
import { MAX_UPLOAD_BYTES } from "@/components/shared/limits";
import { cn } from "@/lib/utils";

export interface UploadCardProps {
  /** Number of dishes currently loaded. */
  itemCount: number;
  sourceFilename: string | undefined;
  warnings: ParseWarning[];
  onLoaded: (result: ParseResult, filename: string) => void;
  onClear: () => void;
}

const ACCEPT = {
  "text/csv": [".csv"],
  "text/tab-separated-values": [".tsv"],
  "text/plain": [".txt"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.ms-excel.sheet.macroenabled.12": [".xlsm"],
};

const TEMPLATE_CSV =
  "dish_name,description,category\r\n" +
  'Margherita Pizza,"Classic tomato sauce, mozzarella, fresh basil",pizza\r\n';

const SAMPLE_URL = "/sample-menu.csv";

/** Read the file with the right decoder for its extension and parse it. */
async function parseFile(file: File): Promise<ParseResult> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const data = CSV_EXTENSIONS.includes(ext) ? await file.text() : await file.arrayBuffer();
  return parseMenuFile({ name: file.name, data });
}

/** Message for the first rejection reason react-dropzone reports. */
function rejectionMessage(rejections: FileRejection[]): string {
  const code = rejections[0]?.errors[0]?.code;
  switch (code) {
    case ErrorCode.FileTooLarge:
      return "That file is larger than 10 MB. Export a smaller sheet and try again.";
    case ErrorCode.FileInvalidType:
      return "Unsupported file type. Use a CSV, TSV or Excel file (.csv, .tsv, .txt, .xlsx, .xls, .xlsm).";
    case ErrorCode.TooManyFiles:
      return "Drop one file at a time.";
    default:
      return "That file could not be accepted. Try a CSV or Excel export.";
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ParseError) return cause.message;
  if (cause instanceof Error) return `Could not read the file: ${cause.message}`;
  return "Could not read the file.";
}

/** Drop zone for CSV/XLSX menus; collapses to a compact summary bar once a file is loaded. */
export function UploadCard({ itemCount, sourceFilename, warnings, onLoaded, onClear }: UploadCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = sourceFilename !== undefined || itemCount > 0;

  const applyResult = useCallback(
    (result: ParseResult, filename: string) => {
      if (result.items.length === 0) {
        setError("No dishes found: every row has an empty dish name. Check the dish_name column and try again.");
        return;
      }
      setError(null);
      onLoaded(result, filename);
    },
    [onLoaded],
  );

  const onDrop = useCallback(
    async (accepted: File[], rejections: FileRejection[]) => {
      if (rejections.length > 0) {
        setError(rejectionMessage(rejections));
        return;
      }
      const file = accepted[0];
      if (!file) return;
      setBusy(true);
      try {
        applyResult(await parseFile(file), file.name);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyResult],
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject, open } = useDropzone({
    onDrop,
    accept: ACCEPT,
    multiple: false,
    maxSize: MAX_UPLOAD_BYTES,
    noClick: loaded,
    noKeyboard: loaded,
    disabled: busy,
  });

  const loadSample = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch(SAMPLE_URL);
      if (!response.ok) throw new Error(`sample menu returned ${response.status}`);
      applyResult(parseCsv(await response.text()), "sample-menu.csv");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = (): void => downloadBlob(TEMPLATE_CSV, "menu-template.csv", "text/csv;charset=utf-8");

  const rootProps = getRootProps({ className: cn(loaded ? "contents" : undefined) });

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div {...rootProps}>
          <input {...getInputProps()} aria-label="Menu file" />
          {loaded ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <FileSpreadsheetIcon className="size-4" aria-hidden />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{sourceFilename ?? "Untitled menu"}</span>
                <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="tabular-nums">{pluralize(itemCount, "dish", "dishes")}</span>
                  {warnings.length > 0 ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={<Badge variant="outline" className="cursor-default gap-1 text-warning" tabIndex={0} />}
                      >
                        <TriangleAlertIcon aria-hidden />
                        {pluralize(warnings.length, "row")} skipped
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-sm">
                        <ul className="list-disc pl-4">
                          {warnings.slice(0, 8).map((warning) => (
                            <li key={`${warning.row}-${warning.message}`}>{warning.message}</li>
                          ))}
                          {warnings.length > 8 ? <li>…and {warnings.length - 8} more</li> : null}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={open} disabled={busy}>
                  {busy ? <Spinner /> : <ReplaceIcon />}
                  Replace
                </Button>
                <Button variant="ghost" size="sm" onClick={onClear} disabled={busy}>
                  <XIcon />
                  Clear
                </Button>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
                "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                isDragActive && !isDragReject && "border-primary bg-primary/5",
                isDragReject && "border-destructive bg-destructive/5",
                !isDragActive && "hover:bg-muted/50",
                busy && "pointer-events-none opacity-70",
              )}
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-muted text-foreground">
                {busy ? <Spinner className="size-5" /> : <CloudUploadIcon className="size-5" aria-hidden />}
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-base font-medium">
                  {isDragReject ? "That file type is not supported" : "Drop your menu here or click to browse"}
                </p>
                <p className="text-sm text-muted-foreground">CSV or Excel · columns: dish_name (required), description, category</p>
              </div>
            </div>
          )}
        </div>

        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Could not load the menu</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!loaded ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void loadSample()} disabled={busy}>
              <ListChecksIcon />
              Use sample menu
            </Button>
            <Button variant="ghost" size="sm" onClick={downloadTemplate} disabled={busy}>
              <FileDownIcon />
              Download template
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

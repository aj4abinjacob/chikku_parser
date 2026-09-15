import React, { useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogBody, Icon, Tag } from "@blueprintjs/core";
import { SearchInput } from "./SearchInput";

interface HelpSection {
  title: string;
  body?: string;
  items?: string[];
}

interface HelpTopic {
  id: string;
  title: string;
  category: string;
  summary: string;
  icon: React.ComponentProps<typeof Icon>["icon"];
  keywords: string[];
  sections: HelpSection[];
}

const HELP_TOPICS: HelpTopic[] = [
  {
    id: "start",
    title: "Start here",
    category: "Essentials",
    summary: "Open files, understand the workspace, and finish your first task.",
    icon: "play",
    keywords: ["begin", "import", "open", "drag", "excel", "session", "first"],
    sections: [
      {
        title: "Your first workflow",
        items: [
          "Open one or more files with Open, drag files onto the window, or use Cmd/Ctrl+O.",
          "Choose a file in the left sidebar. Excel workbooks ask which sheets you want to import.",
          "Inspect, filter, clean, reshape, or compare the data using the grid and sidebar actions.",
          "Use Export when the result is ready. Tabular changes live in this app session and do not overwrite the source file.",
        ],
      },
      {
        title: "Supported files",
        body: "Chikku opens CSV, TSV, Excel (.xlsx/.xls), JSON/JSONL/NDJSON, Markdown, PDF, and Parquet. JSON, Markdown, and PDF open in purpose-built document workspaces; the other formats open as tables.",
      },
      {
        title: "A useful mental model",
        body: "Files are the inputs, the center area is the active workspace, the left sidebar controls the active file, and the status bar opens filters and cleaning tools. Generated results such as pivots, aggregates, samples, merges, and combines appear as new files in the sidebar.",
      },
    ],
  },
  {
    id: "external-changes",
    title: "Files changed outside Chikku",
    category: "Essentials",
    summary: "Notice edits another app made to the open file, and reload on your terms.",
    icon: "refresh",
    keywords: ["reload", "refresh", "changed", "disk", "external", "stale", "deleted", "moved", "watch"],
    sections: [
      {
        title: "When the notice appears",
        body: "If another app changes the file you have open, a banner appears above the workspace the next time the Chikku window comes back into focus. It works for tables, JSON, Markdown, and PDF files. Nothing is reloaded for you, so the version you are looking at never changes underneath you.",
      },
      {
        title: "Reload or keep yours",
        items: [
          "Reload reads the new version from disk and replaces what is on screen.",
          "Keep mine dismisses the banner and keeps what you have. You will be told again if the file changes once more.",
          "When reloading would throw away work, the banner asks for a second confirmation first.",
        ],
      },
      {
        title: "What a reload replaces",
        items: [
          "JSON, Markdown, and PDF: unsaved edits in the workspace are replaced by the file on disk.",
          "Tables: the file is imported again, so column ops, row ops, unsaved QC values, filters, and sorts on that file are cleared. Other files, including pivots and aggregates you generated, are untouched.",
        ],
      },
      {
        title: "Missing files",
        body: "If the file is moved, renamed, or deleted, the banner says so instead of offering a reload. What is already open stays usable; dismiss the notice and export or Save As if you want the content back on disk.",
      },
      {
        title: "Your own saves",
        body: "Saving from inside Chikku never raises the notice. The banner only reports changes made by something else.",
      },
    ],
  },
  {
    id: "grid",
    title: "Explore a table",
    category: "Tabular data",
    summary: "Navigate large datasets, select cells, inspect columns, sort, and group.",
    icon: "panel-table",
    keywords: ["grid", "columns", "copy", "stats", "sort", "group", "resize", "reorder", "url", "link", "live preview"],
    sections: [
      {
        title: "Grid basics",
        items: [
          "Scroll through large files without loading every row into the interface at once.",
          "Click and drag to select cells, then use Cmd/Ctrl+C to copy the selection as tab-separated text.",
          "Use the sort button in a column header to sort. Shift-click the button to add another sort level.",
          "Drag column headers to reorder them, or drag a header edge to resize it. Double-click the edge to auto-fit.",
        ],
      },
      {
        title: "Columns sidebar",
        body: "Show or hide columns with the checkboxes, drag them into a new order, and use the blue sort control or green group control. Shift-click either control to build multi-level sorting or grouping.",
      },
      {
        title: "Column profiles",
        body: "Select the chart icon in a grid header to inspect nulls, unique values, frequent values, numeric summaries, and text profiles. The profile rail also includes quick formatting and cleaning actions where supported.",
      },
      {
        title: "Live link previews",
        body: "Hover over a public HTTPS URL in the grid to open a safe metadata preview with its title, image, and description. To stop loading rich previews, open the View menu and uncheck Live Link Previews. The preference is remembered; URLs remain visible, copyable, and clickable when previews are off.",
      },
    ],
  },
  {
    id: "filter",
    title: "Filter and save views",
    category: "Tabular data",
    summary: "Build reusable AND/OR filters without changing the underlying table.",
    icon: "filter",
    keywords: ["filter", "and", "or", "contains", "in", "view", "bookmark", "status bar"],
    sections: [
      {
        title: "Open the workbench",
        body: "Select Filters in the bottom status bar. Add conditions or nested groups, choose AND/OR logic, then select Apply. The row count shows how many records remain.",
      },
      {
        title: "Filter choices",
        body: "Filters cover text, number, date, null, list, regex, and column-to-column comparisons. IN includes a value picker for choosing values already present in the active table.",
      },
      {
        title: "Saved views",
        body: "Save a view to preserve the current filters, visible columns, column order, sorts, and grouping. Reapply, rename, update, or delete saved views from the Views area beside the filter builder.",
      },
    ],
  },
  {
    id: "clean",
    title: "Clean columns and rows",
    category: "Tabular data",
    summary: "Preview transformations, apply them to filtered rows, and undo safely.",
    icon: "clean",
    keywords: ["clean", "column ops", "row ops", "regex", "replace", "trim", "duplicate", "null", "undo"],
    sections: [
      {
        title: "Column Ops",
        body: "Open the bottom workbench and choose Column Ops. Available operations include find/replace, regex extraction, trim, upper/lower case, set value, prefix/suffix, extract numbers, clear to NULL, rename, and delete. Most operations include a live preview and can replace the source column or write to another column.",
      },
      {
        title: "Row Ops",
        body: "Delete filtered rows, keep only filtered rows, remove empty rows, or remove duplicates. Active filters define the scope for filter-based row operations.",
      },
      {
        title: "Data Ops and Dates",
        body: "Use Data Ops in the sidebar for substring and SQL expressions, create/combine/rename/delete columns, conditional columns, sampling, deduplication, empty-row removal, and NULL cleanup. Dates detects common date formats and converts or reformats date columns.",
      },
      {
        title: "Undo and patterns",
        body: "Column Ops and Row Ops keep an undo history for the session. Regex actions include a pattern picker and a manager for adding, importing, or exporting reusable patterns.",
      },
    ],
  },
  {
    id: "combine",
    title: "Combine, look up, and compare",
    category: "Multi-file workflows",
    summary: "Stack similar files, join related tables, or inspect differences side by side.",
    icon: "data-lineage",
    keywords: ["combine", "union", "lookup", "join", "merge", "compare", "differences", "keys"],
    sections: [
      {
        title: "Combine",
        body: "Select two or more tabular files in the sidebar, then choose Combine. Map corresponding columns to stack their rows into a new combined table. Chikku casts mapped columns to compatible text values when needed.",
      },
      {
        title: "Lookup",
        body: "Use Lookup for LEFT or INNER joins. Match on one or more key pairs, review duplicate or NULL key warnings, and resolve column-name conflicts before creating a merged table or replacing the active one.",
      },
      {
        title: "Compare",
        body: "Open at least two tables and choose Compare. Select match keys and columns to compare, then filter by same, different, missing, or present results. The inspector explains the selected row and value differences.",
      },
    ],
  },
  {
    id: "reshape",
    title: "Aggregate and pivot",
    category: "Analysis",
    summary: "Summarize records or reshape categories into columns.",
    icon: "pivot-table",
    keywords: ["aggregate", "pivot", "sum", "average", "count", "group", "totals"],
    sections: [
      {
        title: "Aggregate",
        body: "Choose Aggregate to calculate grouped summaries such as count, sum, average, minimum, and maximum. The result is materialized as a new aggregate table so the source remains available.",
      },
      {
        title: "Pivot table",
        body: "Choose Pivot to turn distinct category values into columns and aggregate their records. The result appears as a new pivot table.",
      },
      {
        title: "Group View (interactive grouping)",
        body: "For an expandable grouped rollup, use the green group controls beside columns in the sidebar. The Group View toolbar can expand or collapse groups, show a grand total, and change the aggregate applied to every value column (Count by default). Each value-column header shows which aggregate its cells contain.",
      },
    ],
  },
  {
    id: "qc-history",
    title: "Quality control and history",
    category: "Review",
    summary: "Review rows consistently and recover or replay table operations.",
    icon: "history",
    keywords: ["qc", "quality", "review", "history", "replay", "revert", "audit", "save history"],
    sections: [
      {
        title: "QC workflow",
        body: "Open the bottom workbench and choose QC. Create a boolean or option-based review column, optionally add a notes column for free-text comments typed inline in the grid, assign a result directly in the grid, use quick filters to focus on unreviewed rows or a result, then mark the session done. A completed session can be resumed or left in place while you start a new QC column. Reset all clears both the result and the notes.",
      },
      {
        title: "Operation History",
        body: "History records column, row, and data operations for each source table. Revert to the original file or a selected step by re-reading the source and replaying earlier operations. Generated tables do not support source-file revert.",
      },
      {
        title: "Move a recipe between sessions",
        body: "Save History exports the recorded operation recipe. Load History merges recipes for matching open tables, letting you replay the same sequence later.",
      },
    ],
  },
  {
    id: "json",
    title: "JSON workspace",
    category: "Document workspaces",
    summary: "Edit raw JSON, browse its structure, flatten it, compare files, and export rows.",
    icon: "array",
    keywords: ["json", "jsonl", "ndjson", "tree", "raw", "flatten", "format", "minify", "append"],
    sections: [
      {
        title: "Edit and inspect",
        body: "JSON, JSONL, and NDJSON files open with synchronized raw and structured views. Format, Minify, and Wrap help edit the raw text; validation updates as you type. Use Cmd/Ctrl+F to search the tree and Cmd/Ctrl+S to save valid changes.",
      },
      {
        title: "Tree tools",
        body: "Expand nested values, switch between tree and table representations where available, and right-click a tree item to copy its key, value, or path. Array context actions can append values from a column in an open tabular file.",
      },
      {
        title: "Flatten and compare",
        body: "Flatten Preview converts nested data into rows with configurable array handling and delimiters, then exports valid table-shaped results to CSV. Compare opens another loaded JSON beside the source and synchronizes path-based inspection.",
      },
      {
        title: "Saving is different here",
        body: "Unlike tabular operations, Save writes valid JSON back to the current file. Save As creates a copy, Revert returns to the saved version, and the workspace history supports undo, redo, and jumping to earlier snapshots.",
      },
    ],
  },
  {
    id: "markdown",
    title: "Markdown workspace",
    category: "Document workspaces",
    summary: "Read, search, edit, navigate, and export Markdown documents.",
    icon: "document",
    keywords: ["markdown", "md", "preview", "outline", "edit", "pdf", "zoom", "search"],
    sections: [
      {
        title: "Read and navigate",
        body: "Markdown opens as a rendered document with a searchable heading outline. Cmd/Ctrl+F focuses content search, and the zoom controls or standard zoom shortcuts adjust the rendered document.",
      },
      {
        title: "Edit with live preview",
        body: "Choose Edit to show the source beside the rendered preview. Resize the split to suit the task, search the source, and use the outline to jump to headings.",
      },
      {
        title: "Save and export",
        body: "Save writes changes to the current Markdown file. Export creates a Markdown copy, while Export PDF captures the rendered document. Revert and History help recover earlier saved or edited states.",
      },
    ],
  },
  {
    id: "pdf",
    title: "PDF viewer",
    category: "Document workspaces",
    summary: "Read, search, navigate, and add positioned images to a saved PDF copy.",
    icon: "document",
    keywords: ["pdf", "viewer", "pages", "thumbnail", "outline", "password", "signature", "print", "zoom", "rotate", "dark", "night", "contrast", "image", "insert", "save as", "export", "png", "jpeg", "webp", "a4", "dpi"],
    sections: [
      {
        title: "Read and navigate",
        body: "Use thumbnails or the document outline to navigate, enter a page number, search with Cmd/Ctrl+F, and use the zoom and rotate controls without modifying the source file.",
      },
      {
        title: "Choose a page appearance",
        body: "Use the clearly labeled PDF theme menu in the toolbar. Light · Original keeps accurate colors, Dark · Keep colors makes pages darker while preserving recognizable charts and illustrations, and Dark · High contrast turns pages and scans into a simplified light-on-dark palette for reading. Chikku remembers the choice for each loaded PDF during the current session. These modes affect only the viewer and thumbnails; printing, Save As, and image export keep the original colors. Return to Light · Original for photo-heavy, already-dark, or color-critical documents.",
      },
      {
        title: "Insert and position images",
        body: "Choose Image to open an image-only picker for APNG, AVIF, BMP, GIF, ICO, JPEG, PNG, SVG, or WebP files. The image is added to the current page; drag it anywhere, resize it with the handles, or select it and press Delete. Choose Done when positioning is complete, then Save As to create a new PDF while preserving the original.",
      },
      {
        title: "Export pages as images",
        body: "In the left sidebar, choose Export Images under File Options. Preview any page, then choose PNG, JPEG, or WebP; the current page or every page; original, A4, A3, Letter, Legal, or a custom size; orientation; and 96, 150, or 300 DPI. Custom width and height can use pixels, millimetres, or inches. Multi-page exports use numbered filenames such as page-001 and page-002.",
      },
      {
        title: "Protected and signed documents",
        body: "Password-protected PDFs prompt for a password, and content permissions can prevent image insertion. Existing forms and annotations are displayed as static content. Chikku can report that digital signatures are present, but it does not verify them; editing a signed PDF invalidates its signatures in the saved copy.",
      },
      {
        title: "Print or use the system viewer",
        body: "Print is available only when the PDF permissions allow it. Large documents are handed to the system PDF viewer for memory-safe printing. Open externally is also available as a compatibility fallback.",
      },
    ],
  },
  {
    id: "export-shortcuts",
    title: "Export and shortcuts",
    category: "Reference",
    summary: "Choose output formats and keep common actions close at hand.",
    icon: "export",
    keywords: ["export", "csv", "tsv", "excel", "parquet", "shortcut", "keyboard", "dark mode", "f1"],
    sections: [
      {
        title: "Tabular export",
        body: "Export the active table, selected tables, or the current view to CSV, TSV, JSON, Excel, or Parquet. View export can preserve active filters, visible columns, order, and sorting. Excel export warns when worksheet row or column limits may be exceeded.",
      },
      {
        title: "Keyboard shortcuts",
        items: [
          "Cmd/Ctrl+O — Open files",
          "Cmd/Ctrl+Shift+O — Add files to the current session",
          "Cmd/Ctrl+E — Open tabular export",
          "Cmd/Ctrl+C — Copy selected grid cells as TSV",
          "Cmd/Ctrl+Shift+D — Toggle dark mode",
          "F1 — Open this Help Center",
        ],
      },
      {
        title: "Close the loop",
        body: "QC changes are kept in the working table until you export them. If you close a window or quit with unsaved QC, Chikku Parser asks whether to save the complete file, discard the changes, or cancel. For JSON and Markdown, save or export when the sidebar shows Unsaved changes.",
      },
    ],
  },
];

function searchableText(topic: HelpTopic): string {
  return [
    topic.title,
    topic.category,
    topic.summary,
    ...topic.keywords,
    ...topic.sections.flatMap((section) => [section.title, section.body ?? "", ...(section.items ?? [])]),
  ].join(" ").toLowerCase();
}

interface HelpCenterProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HelpCenter({ isOpen, onClose }: HelpCenterProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [selectedTopicId, setSelectedTopicId] = useState(HELP_TOPICS[0].id);

  const filteredTopics = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return HELP_TOPICS;
    return HELP_TOPICS.filter((topic) => searchableText(topic).includes(normalized));
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    if (filteredTopics.some((topic) => topic.id === selectedTopicId)) return;
    setSelectedTopicId(filteredTopics[0]?.id ?? HELP_TOPICS[0].id);
  }, [filteredTopics, isOpen, selectedTopicId]);

  useEffect(() => {
    if (!isOpen) setQuery("");
  }, [isOpen]);

  const selectedTopic = filteredTopics.find((topic) => topic.id === selectedTopicId)
    ?? filteredTopics[0]
    ?? null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Chikku Parser Help"
      icon="help"
      className="help-center-dialog"
      style={{ width: 940, maxWidth: "94vw" }}
      canOutsideClickClose={false}
    >
      <DialogBody className="help-center-dialog-body">
        <div className="help-center">
          <aside className="help-center-nav">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search help..."
              aria-label="Search help"
              autoFocus
            />
            <div className="help-center-topic-list" role="navigation" aria-label="Help topics">
              {filteredTopics.map((topic) => (
                <button
                  key={topic.id}
                  type="button"
                  className={`help-center-topic${topic.id === selectedTopic?.id ? " active" : ""}`}
                  onClick={() => setSelectedTopicId(topic.id)}
                >
                  <Icon icon={topic.icon} size={15} />
                  <span>
                    <strong>{topic.title}</strong>
                    <small>{topic.category}</small>
                  </span>
                </button>
              ))}
              {filteredTopics.length === 0 && (
                <div className="help-center-no-results">
                  <Icon icon="search" size={20} />
                  <strong>No matching help</strong>
                  <span>Try a feature name such as filter, JSON, compare, or export.</span>
                </div>
              )}
            </div>
            <div className="help-center-nav-footer">
              <Icon icon="key-command" size={13} />
              <span>Press F1 anytime</span>
            </div>
          </aside>

          <main className="help-center-content">
            {selectedTopic ? (
              <article key={selectedTopic.id} className="help-center-article">
                <header className="help-center-article-header">
                  <div className="help-center-article-icon">
                    <Icon icon={selectedTopic.icon} size={20} />
                  </div>
                  <div>
                    <Tag minimal>{selectedTopic.category}</Tag>
                    <h2>{selectedTopic.title}</h2>
                    <p>{selectedTopic.summary}</p>
                  </div>
                </header>
                <div className="help-center-sections">
                  {selectedTopic.sections.map((section) => (
                    <section key={section.title}>
                      <h3>{section.title}</h3>
                      {section.body && <p>{section.body}</p>}
                      {section.items && (
                        <ol>
                          {section.items.map((item) => <li key={item}>{item}</li>)}
                        </ol>
                      )}
                    </section>
                  ))}
                </div>
              </article>
            ) : (
              <div className="help-center-empty-content">
                <Icon icon="search" size={24} />
                <h2>No results</h2>
                <p>Clear the search to browse every topic.</p>
                <Button text="Clear search" onClick={() => setQuery("")} />
              </div>
            )}
          </main>
        </div>
      </DialogBody>
    </Dialog>
  );
}

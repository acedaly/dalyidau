// Capture: the quickest ways to get something into the register. Quick add needs a name and a
// category. Photo and receipt capture store the file in your own capture inbox first; with AI on,
// you can ask for a suggestion, which is shown for you to check and only fills in the form. Scan
// reads a QR label (opening the asset) or a product barcode, where the browser can.
import { useEffect, useRef, useState } from "react";
import { Camera01, Package, QrCode02, Receipt, SearchLg, Stars02 } from "@untitledui/icons";
import { Tabs } from "@/components/application/tabs/tabs";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { Card } from "@/portal/knowledge/pages/knowledge-home-page";
import { errorMessage } from "@/portal/lib/api";
import { formatMoney } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { parseAssetAddress } from "@/shared/assets/address";
import type { AssetFileView, PhotoProposal, ReceiptProposal } from "@/shared/assets/types";
import { assetsApi, fileUrl } from "../assets-api";
import { AssetForm } from "../forms";
import { ASSETS, AssetsHeader, assetHref, prepareFile } from "../shared";

type Mode = PageData<"assets-capture">["mode"];

/** A button-styled label around a file input, so phones offer the camera directly. */
const CameraButton = ({
    label,
    capture,
    accept,
    onFile,
    isDisabled,
}: {
    label: string;
    capture?: boolean;
    accept: string;
    onFile: (f: File) => void;
    isDisabled?: boolean;
}) => (
    <label
        className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white shadow-xs outline-focus-ring transition duration-100 ease-linear focus-within:outline-2 focus-within:outline-offset-2 hover:bg-brand-solid_hover ${isDisabled ? "pointer-events-none opacity-50" : ""}`}
    >
        <Camera01 aria-hidden="true" className="size-5" />
        {label}
        <input
            type="file"
            accept={accept}
            {...(capture ? { capture: "environment" } : {})}
            className="sr-only"
            disabled={isDisabled}
            onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = "";
            }}
        />
    </label>
);

const Proposed = ({ label, value, grounded, evidence }: { label: string; value: string; grounded?: boolean; evidence?: string | null }) => (
    <li className="flex flex-col text-sm">
        <span>
            <span className="text-tertiary">{label}: </span>
            <span className="font-medium text-primary">{value}</span>{" "}
            {grounded === false && (
                <Badge size="sm" type="color" color="warning">
                    Not found in the document
                </Badge>
            )}
        </span>
        {evidence && <span className="text-xs text-tertiary">“{evidence}”</span>}
    </li>
);

const FileCapture = ({ data, kind }: { data: PageData<"assets-capture">; kind: "photo" | "receipt" }) => {
    const toast = useToast();
    const preset = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("file");
    const [file, setFile] = useState<AssetFileView | null>(() => data.inbox.find((f) => f.id === preset) ?? null);
    const [busy, setBusy] = useState(false);
    const [receipt, setReceipt] = useState<ReceiptProposal | null>(null);
    const [photo, setPhoto] = useState<PhotoProposal | null>(null);
    const [form, setForm] = useState(false);
    const store = async (f: File) => {
        setBusy(true);
        setReceipt(null);
        setPhoto(null);
        try {
            const prepared = await prepareFile(f, kind === "photo" ? "photo" : "receipt");
            const result = await assetsApi.upload({
                ...prepared,
                kind: kind === "photo" ? "photo" : "receipt",
                ...(kind === "photo" ? { photoTag: "purchase" } : {}),
            });
            setFile(result.file);
            if (result.duplicate) toast.success("You've added this before", "It's already in your capture inbox.");
        } catch (e) {
            toast.error("Couldn't store it", e instanceof Error ? e.message : errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const suggest = async () => {
        if (!file) return;
        setBusy(true);
        try {
            if (kind === "photo") setPhoto((await assetsApi.photo(file.id)).proposal);
            else setReceipt((await assetsApi.receipt(file.id)).proposal);
        } catch (e) {
            toast.error("No suggestion", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    const firstItem = receipt?.items[0];
    const defaults = receipt
        ? {
              name: firstItem?.description.value ?? "",
              purchaseDate: receipt.purchaseDate?.grounded ? receipt.purchaseDate.value : "",
              purchasePrice: (firstItem?.amountCents ?? receipt.totalCents)?.grounded
                  ? ((firstItem?.amountCents ?? receipt.totalCents)!.value / 100).toFixed(2)
                  : "",
              purchaseLocation: receipt.merchant?.value ?? "",
          }
        : photo
          ? {
                name: [photo.manufacturer, photo.itemType].filter(Boolean).join(" "),
                category: photo.category ?? undefined,
                manufacturer: photo.manufacturer ?? "",
                model: photo.model ?? "",
                description: photo.description ?? "",
            }
          : undefined;
    return (
        <div className="flex flex-col gap-6">
            <Card title={kind === "photo" ? "Photograph the item" : "Photograph or upload the receipt"} icon={kind === "photo" ? Camera01 : Receipt}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    <p className="text-sm text-tertiary">
                        {kind === "photo"
                            ? "The photo is resized and its location data removed before it's stored in your capture inbox."
                            : "The receipt is stored in your capture inbox, then attached to the asset you create from it."}
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <CameraButton
                            label={kind === "photo" ? "Take a photo" : "Photograph receipt"}
                            capture
                            accept="image/*"
                            onFile={(f) => void store(f)}
                            isDisabled={busy}
                        />
                        {kind === "receipt" && (
                            <CameraButton label="Upload a PDF or image" accept="image/*,application/pdf" onFile={(f) => void store(f)} isDisabled={busy} />
                        )}
                    </div>
                    {file && (
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                            {file.contentType.startsWith("image/") ? (
                                <img
                                    src={fileUrl(file.id, file.hasThumb)}
                                    alt="What you captured"
                                    className="size-32 rounded-lg object-cover ring-1 ring-secondary"
                                />
                            ) : (
                                <a href={fileUrl(file.id)} className="text-sm text-brand-secondary hover:underline">
                                    {file.filename}
                                </a>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {data.canAi && (
                                    <Button size="md" color="secondary" iconLeading={Stars02} isLoading={busy} onClick={() => void suggest()}>
                                        Suggest details
                                    </Button>
                                )}
                                <Button size="md" iconLeading={Package} onClick={() => setForm(true)}>
                                    Create the asset
                                </Button>
                            </div>
                        </div>
                    )}
                    {!data.canAi && data.aiNote && file && <p className="text-xs text-tertiary">{data.aiNote}</p>}
                </div>
            </Card>
            {receipt && (
                <Card title="Suggested from the receipt" icon={Stars02}>
                    <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                        <p className="text-xs text-tertiary">{receipt.note}</p>
                        <ul className="flex flex-col gap-2">
                            {receipt.merchant && (
                                <Proposed
                                    label="Bought from"
                                    value={receipt.merchant.value}
                                    grounded={receipt.merchant.grounded}
                                    evidence={receipt.merchant.evidence}
                                />
                            )}
                            {receipt.purchaseDate && (
                                <Proposed
                                    label="Date"
                                    value={receipt.purchaseDate.value}
                                    grounded={receipt.purchaseDate.grounded}
                                    evidence={receipt.purchaseDate.evidence}
                                />
                            )}
                            {receipt.items.map((i, n) => (
                                <Proposed
                                    key={n}
                                    label="Item"
                                    value={`${i.description.value}${i.amountCents ? ` · ${formatMoney(i.amountCents.value)}` : ""}`}
                                    grounded={i.amountCents?.grounded ?? i.description.grounded}
                                    evidence={i.amountCents?.evidence ?? i.description.evidence}
                                />
                            ))}
                            {receipt.totalCents && (
                                <Proposed
                                    label="Total"
                                    value={formatMoney(receipt.totalCents.value)}
                                    grounded={receipt.totalCents.grounded}
                                    evidence={receipt.totalCents.evidence}
                                />
                            )}
                            {receipt.warranty && <Proposed label="Warranty wording" value={receipt.warranty.value} grounded={receipt.warranty.grounded} />}
                        </ul>
                        <p className="text-xs text-tertiary">Only values found in the document are put into the form. Check each one against the receipt.</p>
                    </div>
                </Card>
            )}
            {photo && (
                <Card title="Suggested from the photo" icon={Stars02}>
                    <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                        <Notice title={`A guess, ${photo.confidence} confidence`} color="warning">
                            {photo.note}
                        </Notice>
                        <ul className="flex flex-col gap-2">
                            {photo.itemType && <Proposed label="Looks like" value={photo.itemType} />}
                            {photo.manufacturer && <Proposed label="Maker shown" value={photo.manufacturer} />}
                            {photo.model && <Proposed label="Model shown" value={photo.model} />}
                            {photo.description && <Proposed label="Description" value={photo.description} />}
                        </ul>
                    </div>
                </Card>
            )}
            {form && (
                <AssetForm
                    categories={data.categories}
                    locations={data.locations}
                    defaults={defaults}
                    fileIds={file ? [file.id] : []}
                    onSaved={(a) => {
                        window.location.href = assetHref(a.id);
                    }}
                    onClose={() => setForm(false)}
                />
            )}
        </div>
    );
};

interface Detector {
    detect(source: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string; format: string }[]>;
}
const detectorClass = () =>
    typeof window !== "undefined" && "BarcodeDetector" in window
        ? (window as unknown as { BarcodeDetector: new (o?: { formats: string[] }) => Detector }).BarcodeDetector
        : null;

const Scan = ({ data }: { data: PageData<"assets-capture"> }) => {
    const toast = useToast();
    const video = useRef<HTMLVideoElement>(null);
    const [scanning, setScanning] = useState(false);
    const [manual, setManual] = useState("");
    const [result, setResult] = useState<{ code: string; matches: { id: string; name: string }[] } | null>(null);
    const [form, setForm] = useState<string | null>(null);
    const [supported, setSupported] = useState<boolean | null>(null);
    useEffect(() => setSupported(!!detectorClass() && !!navigator.mediaDevices?.getUserMedia), []);

    const handle = async (code: string) => {
        const address = parseAssetAddress(code, window.location.origin);
        if (address) {
            window.location.href = `${assetHref(address.id)}${address.labelVersion ? `?v=${address.labelVersion}` : ""}`;
            return;
        }
        if (/^https?:\/\//i.test(code)) {
            // Never follow an address that isn't one of this portal's asset labels.
            toast.error("Not a Home & Assets label", "That code points somewhere else, so it wasn't opened.");
            return;
        }
        try {
            const { results } = await assetsApi.search(code);
            const exact = results.assets.filter((a) => a.barcode === code || a.serialNumber === code);
            if (exact.length === 1) window.location.href = assetHref(exact[0].id);
            else setResult({ code, matches: (exact.length ? exact : results.assets).map((a) => ({ id: a.id, name: a.name })) });
        } catch (e) {
            toast.error("Search failed", errorMessage(e));
        }
    };

    useEffect(() => {
        if (!scanning) return;
        const Detector = detectorClass();
        if (!Detector) return;
        const detector = new Detector({ formats: ["qr_code", "ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"] });
        let stream: MediaStream | null = null;
        let timer = 0;
        let stopped = false;
        void navigator.mediaDevices
            .getUserMedia({ video: { facingMode: "environment" } })
            .then((s) => {
                stream = s;
                if (!video.current) return;
                video.current.srcObject = s;
                void video.current.play();
                const tick = async () => {
                    if (stopped || !video.current) return;
                    try {
                        const codes = await detector.detect(video.current);
                        if (codes[0]) {
                            stopped = true;
                            setScanning(false);
                            await handle(codes[0].rawValue);
                            return;
                        }
                    } catch {
                        // Not ready yet.
                    }
                    timer = window.setTimeout(() => void tick(), 300);
                };
                void tick();
            })
            .catch(() => {
                toast.error("The camera isn't available", "Allow camera access, or type the code instead.");
                setScanning(false);
            });
        return () => {
            stopped = true;
            window.clearTimeout(timer);
            stream?.getTracks().forEach((t) => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scanning]);

    return (
        <div className="flex flex-col gap-6">
            <Card title="Scan a label or barcode" icon={QrCode02}>
                <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
                    {supported === false && (
                        <Notice title="Scanning isn't available in this browser">
                            On an iPhone or iPad, point the Camera app at a Home & Assets label: it opens the asset's page after you sign in. For product
                            barcodes, type the number below.
                        </Notice>
                    )}
                    {supported && (
                        <>
                            {scanning ? (
                                <video
                                    ref={video}
                                    muted
                                    playsInline
                                    aria-label="Camera view"
                                    className="aspect-video w-full max-w-lg rounded-lg bg-black object-cover"
                                />
                            ) : (
                                <Button size="md" iconLeading={Camera01} onClick={() => setScanning(true)} className="self-start">
                                    Start the camera
                                </Button>
                            )}
                            {scanning && (
                                <Button size="md" color="secondary" onClick={() => setScanning(false)} className="self-start">
                                    Stop
                                </Button>
                            )}
                        </>
                    )}
                    <form
                        className="flex flex-col gap-2 sm:flex-row sm:items-end"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (manual.trim()) void handle(manual.trim());
                        }}
                    >
                        <Input
                            label="Or type a code"
                            value={manual}
                            onChange={setManual}
                            hint="A barcode, serial number, or a label's address"
                            className="sm:w-96"
                        />
                        <Button size="md" color="secondary" type="submit" iconLeading={SearchLg}>
                            Find
                        </Button>
                    </form>
                    <p className="text-xs text-tertiary">
                        Codes are matched against your own records only. Nothing is looked up in an outside product catalogue.
                    </p>
                </div>
            </Card>
            {result && (
                <Card title={`Code ${result.code}`} icon={SearchLg}>
                    <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                        {result.matches.length ? (
                            <ul className="flex flex-col gap-1">
                                {result.matches.map((m) => (
                                    <li key={m.id}>
                                        <a href={assetHref(m.id)} className="text-sm text-brand-secondary hover:underline">
                                            {m.name}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-tertiary">No asset has this code.</p>
                        )}
                        <Button size="sm" color="secondary" iconLeading={Package} onClick={() => setForm(result.code)} className="self-start">
                            Add an asset with this barcode
                        </Button>
                    </div>
                </Card>
            )}
            {form && (
                <AssetForm
                    categories={data.categories}
                    locations={data.locations}
                    defaults={{ barcode: form }}
                    onSaved={(a) => {
                        window.location.href = assetHref(a.id);
                    }}
                    onClose={() => setForm(null)}
                />
            )}
        </div>
    );
};

export const AssetsCapturePage = ({ data }: { data: PageData<"assets-capture"> }) => {
    const [mode, setMode] = useState<Mode>(data.mode);
    const [quick, setQuick] = useState(data.mode === "quick");
    const switchMode = (m: Mode) => {
        setMode(m);
        window.history.replaceState(null, "", `${ASSETS}/capture${m === "quick" ? "" : `?mode=${m}`}`);
        if (m === "quick") setQuick(true);
    };
    return (
        <>
            <AssetsHeader
                title="Capture and scan"
                description="Add something quickly, from a photo or a receipt, or scan a label."
                crumbs={[{ label: "Capture" }]}
            />
            {!data.canAi && data.aiNote && <p className="text-sm text-tertiary">Everything here works by hand. {data.aiNote}</p>}
            <Tabs selectedKey={mode} onSelectionChange={(k) => switchMode(k as Mode)} className="gap-6">
                <Tabs.List type="button-gray" size="sm" aria-label="How to capture" className="w-max max-w-full overflow-x-auto">
                    <Tabs.Item id="quick">Quick add</Tabs.Item>
                    <Tabs.Item id="photo">From a photo</Tabs.Item>
                    <Tabs.Item id="receipt">From a receipt</Tabs.Item>
                    <Tabs.Item id="scan">Scan</Tabs.Item>
                </Tabs.List>
                <Tabs.Panel id="quick">
                    <Card title="Quick add" icon={Package}>
                        <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
                            <p className="text-sm text-tertiary">A name and a category is enough. Add photos, receipts and details later.</p>
                            <Button size="md" iconLeading={Package} onClick={() => setQuick(true)} className="self-start">
                                Add an asset
                            </Button>
                        </div>
                    </Card>
                </Tabs.Panel>
                <Tabs.Panel id="photo">
                    <FileCapture data={data} kind="photo" />
                </Tabs.Panel>
                <Tabs.Panel id="receipt">
                    <FileCapture data={data} kind="receipt" />
                </Tabs.Panel>
                <Tabs.Panel id="scan">
                    <Scan data={data} />
                </Tabs.Panel>
            </Tabs>
            {quick && mode === "quick" && (
                <AssetForm
                    categories={data.categories}
                    locations={data.locations}
                    onSaved={(a) => {
                        window.location.href = assetHref(a.id);
                    }}
                    onClose={() => setQuick(false)}
                />
            )}
        </>
    );
};

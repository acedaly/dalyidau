import { renderToString } from "react-dom/server.edge";
import { App } from "@/app";
import type { WeddingPageData } from "@/shared/portal/types";
import type { PageData } from "@/shared/types";
import { WeddingApp } from "@/wedding/wedding-app";

export const render = (data: PageData, path: string) => renderToString(<App data={data} path={path} />);

export const renderWedding = (data: WeddingPageData, path: string) => renderToString(<WeddingApp data={data} path={path} />);

import { renderToString } from "react-dom/server.edge";
import { App } from "@/app";
import type { PageData } from "@/shared/types";

export const render = (data: PageData, path: string) => renderToString(<App data={data} path={path} />);

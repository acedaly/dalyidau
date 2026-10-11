import { mock, sync } from "./helpers";

export default async function globalSetup() {
    await mock("reset");
    await sync();
}

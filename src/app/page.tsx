import type { Metadata } from "next";
import { Workspace } from "@/components/workspace";

export const metadata: Metadata = {
  title: { absolute: "MenuGen — AI food photos for every dish" },
  description: "Upload a CSV or Excel menu, pick an image model and style, and download a ZIP of AI-generated dish photos.",
};

/** The single-page workspace. `?job=<id>` opens the results view for that batch. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const job = params.job;
  const initialJobId = typeof job === "string" && job.trim() !== "" ? job : null;
  return <Workspace initialJobId={initialJobId} />;
}

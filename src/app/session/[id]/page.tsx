"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const Workspace = dynamic(() => import("@/components/Workspace"), { ssr: false });

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  return <Workspace id={id} />;
}

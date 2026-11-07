"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const Analytics = dynamic(() => import("@/components/Analytics"), { ssr: false });

export default function StatsPage() {
  const { id } = useParams<{ id: string }>();
  return <Analytics id={id} />;
}

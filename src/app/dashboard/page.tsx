"use client";

import dynamic from "next/dynamic";

// Sessions live in localStorage, so the page renders in the browser only.
const Dashboard = dynamic(() => import("@/components/Dashboard"), { ssr: false });

export default function DashboardPage() {
  return <Dashboard />;
}

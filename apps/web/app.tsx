import { createRoot } from "react-dom/client";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";
import "./app.css";
import { RuntimeProvider } from "./runtime-context";
import { DashboardLayout } from "./layouts/dashboard-layout";
import { AgentsPage } from "./pages/agents-page";
import { ChatPage } from "./pages/chat-page";
import { ChatsPage } from "./pages/chats-page";
import { JobsPage } from "./pages/jobs-page";
import { TracesPage } from "./pages/traces-page";

const router = createBrowserRouter([
  {
    path: "/",
    element: <DashboardLayout />,
    children: [
      { index: true, element: <ChatPage /> },
      { path: "chat", element: <Navigate to="/" replace /> },
      { path: "traces", element: <TracesPage /> },
      { path: "chats", element: <ChatsPage /> },
      { path: "jobs", element: <JobsPage /> },
      { path: "agents", element: <AgentsPage /> },
    ],
  },
]);

function App() {
  return (
    <RuntimeProvider>
      <RouterProvider router={router} />
    </RuntimeProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

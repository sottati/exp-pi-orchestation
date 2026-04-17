import { createRoot } from "react-dom/client";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";
import "./app.css";
import { RuntimeProvider } from "./runtime-context";
import { DashboardLayout } from "./layouts/dashboard-layout";
import { readAuthToken } from "./auth-token";
import { AgentsPage } from "./pages/agents-page";
import { ChatPage } from "./pages/chat-page";
import { ChatsPage } from "./pages/chats-page";
import { JobsPage } from "./pages/jobs-page";
import { LoginPage } from "./pages/login-page";
import { TracesPage } from "./pages/traces-page";

function ProtectedDashboardLayout() {
  const token = readAuthToken();
  if (!token) return <Navigate to="/login" replace />;
  return (
    <RuntimeProvider>
      <DashboardLayout />
    </RuntimeProvider>
  );
}

function LoginRoute() {
  const token = readAuthToken();
  if (token) return <Navigate to="/" replace />;
  return <LoginPage />;
}

const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginRoute />,
  },
  {
    path: "/",
    element: <ProtectedDashboardLayout />,
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
  return <RouterProvider router={router} />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

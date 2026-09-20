import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { Header } from './components/layout/Header.jsx';
import { HomePage } from './pages/HomePage.jsx';
import { ArticlePage } from './pages/ArticlePage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { SignupPage } from './pages/SignupPage.jsx';
import { HistoryPage } from './pages/HistoryPage.jsx';
import { BookmarksPage } from './pages/BookmarksPage.jsx';
import { ProfilePage } from './pages/ProfilePage.jsx';

export default function App() {
  return (
    <AuthProvider>
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/a/:id" element={<ArticlePage />} />
          <Route path="/a/:id/:slug" element={<ArticlePage />} />
          <Route path="/u/:username" element={<ProfilePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/bookmarks" element={<BookmarksPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="*" element={<p className="empty-state">Page not found.</p>} />
        </Routes>
      </main>
    </AuthProvider>
  );
}

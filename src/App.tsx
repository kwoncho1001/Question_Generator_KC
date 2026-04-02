/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Plus, 
  Search, 
  BookOpen, 
  FileUp, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  Loader2, 
  ChevronRight, 
  Database,
  History,
  LayoutDashboard,
  Settings,
  Filter,
  Trash2,
  FileText
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  collection, 
  addDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  doc,
  updateDoc,
  Timestamp,
  getDocFromServer,
  getDoc,
  setDoc,
  deleteDoc
} from 'firebase/firestore';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { db, auth } from './lib/firebase';
import { Problem, generateSimilarProblems, parsePdfToProblems } from './services/geminiService';
import { PDFDocument } from 'pdf-lib';
import { calculateHash } from './lib/utils';
import { 
  getLocalProblems, 
  getLocalMetadata, 
  saveProblem, 
  deleteProblem 
} from './lib/db';

// --- Types ---
interface GenerationLog {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  message: string;
  progress: number;
  createdAt: any;
}

// --- Components ---

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [hasError, setHasError] = useState(false);
  const [errorInfo, setErrorInfo] = useState<string | null>(null);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      setHasError(true);
      setErrorInfo(event.message);
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <div className="p-8 bg-red-50 text-red-800 rounded-lg border border-red-200 m-4">
        <h2 className="text-xl font-bold mb-2">문제가 발생했습니다.</h2>
        <p className="mb-4">{errorInfo}</p>
        <button 
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition"
        >
          새로고침
        </button>
      </div>
    );
  }

  return <>{children}</>;
};

const SUBJECT_STRUCTURE: Record<string, string[]> = {
  '국어': ['독서', '문학', '화법과 작문', '언어와 매체'],
  '수학': ['수학Ⅰ', '수학Ⅱ', '확률과 통계', '미적분', '기하'],
  '영어': ['영어Ⅰ', '영어Ⅱ', '듣기', '독해'],
  '과학': ['물리학Ⅰ', '물리학Ⅱ', '화학Ⅰ', '화학Ⅱ', '생명과학Ⅰ', '생명과학Ⅱ', '지구과학Ⅰ', '지구과학Ⅱ'],
  '사회': ['생활과 윤리', '윤리와 사상', '한국지리', '세계지리', '동아시아사', '세계사', '경제', '정치와 법', '사회·문화']
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'bank' | 'generate' | 'logs' | 'upload'>('dashboard');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ subject: '', large_unit: '', source_id: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProblemIds, setSelectedProblemIds] = useState<string[]>([]);
  const [problemToDelete, setProblemToDelete] = useState<string | null>(null);
  const [currentPdfUrl, setCurrentPdfUrl] = useState<string | null>(null);

  // Auth Effect
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Data Fetching Effect
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const syncProblems = async () => {
      try {
        // 1. 로컬 데이터 및 메타데이터 가져오기
        const localProblems = await getLocalProblems();
        const localMetadata = await getLocalMetadata();
        setProblems(localProblems);

        // 2. 서버에서 단일 메타데이터 문서(global_hash_map) 가져오기
        const globalMetaSnap = await getDoc(doc(db, 'problem_metadata', 'global_hash_map'));
        const serverHashes: Record<string, string> = globalMetaSnap.exists() ? (globalMetaSnap.data()?.hashes || {}) : {};

        // 3. 동기화 로직
        // 3-1. 삭제된 문제 처리 (서버 해시맵에 없는 로컬 데이터 삭제)
        for (const local of localMetadata) {
          if (!serverHashes[local.problem_id] && !local.problem_id.startsWith('local_')) {
            await deleteProblem(local.problem_id);
          }
        }

        // 3-2. 변경/추가된 문제 ID 추려내기
        const idsToFetch: string[] = [];
        for (const [serverId, serverHash] of Object.entries(serverHashes)) {
          const local = localMetadata.find(m => m.problem_id === serverId);
          if (!local || local.hash !== serverHash) {
            idsToFetch.push(serverId);
          }
        }

        // 3-3. 필요한 문제만 묶어서(Batch) 가져오기 (Firestore 'in' 쿼리는 최대 10개)
        if (idsToFetch.length > 0) {
          const chunkSize = 10;
          for (let i = 0; i < idsToFetch.length; i += chunkSize) {
            const chunk = idsToFetch.slice(i, i + chunkSize);
            const q = query(collection(db, 'problems'), where('__name__', 'in', chunk));
            const querySnapshot = await getDocs(q);
            
            for (const docSnap of querySnapshot.docs) {
              const problemData = docSnap.data() as Problem;
              const hash = serverHashes[docSnap.id];
              await saveProblem({ ...problemData, problem_id: docSnap.id }, hash);
            }
          }
        }

        // 4. 로컬 데이터 다시 불러와서 상태 업데이트
        setProblems(await getLocalProblems());
      } catch (error: any) {
        if (error?.message?.includes('client is offline')) {
          // 오프라인 상태는 로컬 우선 아키텍처에서 정상적인 상황이므로 경고 생략
          console.log("Running in offline mode (local data only).");
        } else {
          console.warn("Firebase sync failed (offline or quota exceeded), using local data only:", error);
        }
        // 동기화 실패해도 로컬 데이터로 계속 작동
      }
    };

    syncProblems();
  }, [user, isAuthReady]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const executeDeleteProblem = async () => {
    if (!problemToDelete) return;
    const problemId = problemToDelete;
    setProblemToDelete(null);
    
    console.log("Deleting problem:", problemId);
    try {
      // 1. 로컬 DB 삭제
      await deleteProblem(problemId);
      console.log("Local DB deleted");
      
      // 2. Firebase 삭제 (실패하더라도 로컬 삭제는 유지되도록 분리)
      try {
        const q = query(collection(db, 'problems'), where('__name__', '==', problemId));
        const querySnapshot = await getDocs(q);
        console.log("Firebase docs found:", querySnapshot.size);
        for (const docSnap of querySnapshot.docs) {
          await deleteDoc(docSnap.ref);
          console.log("Firebase doc deleted:", docSnap.id);
        }
      } catch (fbError) {
        console.warn("Firebase delete failed (offline or permission), but local data will be deleted:", fbError);
      }
      
      // 3. 상태 업데이트
      setProblems(prev => prev.filter(p => p.problem_id !== problemId));
      console.log("State updated");
    } catch (error) {
      console.error("문제 삭제 실패:", error);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fileUrl = URL.createObjectURL(file);
    setCurrentPdfUrl(fileUrl);

    setLoading(true);
    const logId = Date.now().toString();
    setLogs(prev => [{
      id: logId,
      status: 'processing',
      message: 'PDF 파일을 읽는 중...',
      progress: 0,
      createdAt: new Date()
    }, ...prev]);

    const updateLog = (updates: Partial<GenerationLog>) => {
      setLogs(prev => prev.map(log => log.id === logId ? { ...log, ...updates } : log));
    };

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const pageCount = pdfDoc.getPageCount();
      const CHUNK_SIZE = 5; // 5페이지씩 분할
      const totalChunks = Math.ceil(pageCount / CHUNK_SIZE);
      
      let allParsedProblems: Problem[] = [];
      let lastExamSource = '';

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min((i + 1) * CHUNK_SIZE, pageCount);
        
        updateLog({
          message: `PDF 분석 중: ${i + 1}/${totalChunks} 구역 처리 중 (${start + 1}~${end} 페이지)...`,
          progress: Math.round((i / totalChunks) * 100)
        });

        // 새로운 PDF 조각 생성
        const chunkDoc = await PDFDocument.create();
        const pages = await chunkDoc.copyPages(pdfDoc, Array.from({ length: end - start }, (_, k) => start + k));
        pages.forEach(page => chunkDoc.addPage(page));
        
        const chunkBase64 = await chunkDoc.saveAsBase64();
        const chunkProblems = await parsePdfToProblems(chunkBase64);
        
        // 시험 출처 보정: 현재 청크에서 출처를 못 찾았으면 이전 청크의 출처 사용
        const processedProblems = chunkProblems.map(p => {
          if (p.source_id && p.source_id !== '출처 미상' && p.source_id !== '알 수 없음') {
            lastExamSource = p.source_id;
            return p;
          }
          return { ...p, source_id: lastExamSource || p.source_id };
        });

        allParsedProblems = [...allParsedProblems, ...processedProblems];
      }

      // 결과 저장 (로컬 우선)
      for (const p of allParsedProblems) {
        const localId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const problemWithId = { ...p, problem_id: localId };
        const hash = await calculateHash(problemWithId);
        
        // 1. 로컬 DB 및 상태 즉시 업데이트
        await saveProblem(problemWithId, hash);
        setProblems(prev => [problemWithId, ...prev]);

        // 2. 백그라운드에서 Firebase 백업 시도
        (async () => {
          try {
            const docRef = await addDoc(collection(db, 'problems'), p);
            // Firebase ID로 로컬 데이터 교체
            const finalProblem = { ...p, problem_id: docRef.id };
            const finalHash = await calculateHash(finalProblem);
            
            await setDoc(doc(db, 'problem_metadata', 'global_hash_map'), { hashes: { [docRef.id]: finalHash } }, { merge: true });
            await saveProblem(finalProblem, finalHash);
            await deleteProblem(localId); // 임시 로컬 ID 삭제
            
            setProblems(prev => prev.map(item => item.problem_id === localId ? finalProblem : item));
          } catch (backupError: any) {
            if (!backupError?.message?.includes('client is offline')) {
              console.warn("Firebase backup failed (offline or quota exceeded), keeping local data:", backupError);
            }
            // 백업 실패해도 로컬에는 남아있음
          }
        })();
      }

      updateLog({
        status: 'completed',
        message: `분석 완료: 총 ${allParsedProblems.length}개의 문제를 성공적으로 추출했습니다.`,
        progress: 100
      });
      
      // 분석 완료 후 문제은행 탭으로 이동하여 결과 확인
      setActiveTab('bank');
      
    } catch (error) {
      console.error("PDF chunking failed:", error);
      updateLog({
        status: 'failed',
        message: `오류 발생: ${error instanceof Error ? error.message : 'PDF 분석 중 문제가 발생했습니다.'}`,
        progress: 0
      });
    } finally {
      setLoading(false);
      setCurrentPdfUrl(null);
      if (e.target) e.target.value = ''; // input 초기화
    }
  };

  // ... (나머지 렌더링 로직 유지)

  const handleBatchGenerate = async (selectedProblems: Problem[]) => {
    if (selectedProblems.length === 0) return;

    setLoading(true);
    const logId = Date.now().toString();
    setLogs(prev => [{
      id: logId,
      status: 'processing',
      message: `${selectedProblems.length}개의 문제에 대한 유사 문제 생성을 시작합니다...`,
      progress: 0,
      createdAt: new Date()
    }, ...prev]);

    const updateLog = (updates: Partial<GenerationLog>) => {
      setLogs(prev => prev.map(log => log.id === logId ? { ...log, ...updates } : log));
    };

    try {
      let completed = 0;
      for (const original of selectedProblems) {
        const generated = await generateSimilarProblems(original, 1);
        for (const g of generated) {
          const localId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const problemWithId = { ...g, problem_id: localId };
          const hash = await calculateHash(problemWithId);
          
          // 1. 로컬 DB 및 상태 즉시 업데이트
          await saveProblem(problemWithId, hash);
          setProblems(prev => [problemWithId, ...prev]);

          // 2. 백그라운드에서 Firebase 백업 시도
          (async () => {
            try {
              const docRef = await addDoc(collection(db, 'problems'), g);
              const finalProblem = { ...g, problem_id: docRef.id };
              const finalHash = await calculateHash(finalProblem);
              
              await setDoc(doc(db, 'problem_metadata', 'global_hash_map'), { hashes: { [docRef.id]: finalHash } }, { merge: true });
              await saveProblem(finalProblem, finalHash);
              await deleteProblem(localId);
              
              setProblems(prev => prev.map(item => item.problem_id === localId ? finalProblem : item));
            } catch (backupError: any) {
              if (!backupError?.message?.includes('client is offline')) {
                console.warn("Firebase backup failed for generated problem (offline or quota exceeded), keeping local data:", backupError);
              }
            }
          })();
        }
        completed++;
        updateLog({
          progress: Math.round((completed / selectedProblems.length) * 100),
          message: `${completed}/${selectedProblems.length} 완료됨...`
        });
      }

      updateLog({
        status: 'completed',
        message: '모든 유사 문제 생성이 완료되었습니다.',
        progress: 100
      });
    } catch (error) {
      console.error("Batch generation failed:", error);
      updateLog({
        status: 'failed',
        message: '유사 문제 생성 중 오류가 발생했습니다.',
        progress: 0
      });
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-50 p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center"
        >
          <BookOpen className="w-16 h-16 text-blue-600 mx-auto mb-6" />
          <h1 className="text-2xl font-bold text-gray-900 mb-2">평가원 스타일 문제은행</h1>
          <p className="text-gray-600 mb-8">유사 문제를 생성하고 체계적으로 관리하세요.</p>
          <button 
            onClick={handleLogin}
            className="w-full py-3 px-4 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition flex items-center justify-center gap-2"
          >
            Google 계정으로 시작하기
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50 flex">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-3 text-blue-600">
              <Database className="w-6 h-6" />
              <span className="font-bold text-lg">QuestionBank</span>
            </div>
          </div>
          
          <nav className="flex-1 p-4 space-y-2">
            <SidebarItem 
              icon={<LayoutDashboard />} 
              label="대시보드" 
              active={activeTab === 'dashboard'} 
              onClick={() => setActiveTab('dashboard')} 
            />
            <SidebarItem 
              icon={<BookOpen />} 
              label="문제은행" 
              active={activeTab === 'bank'} 
              onClick={() => setActiveTab('bank')} 
            />
            <SidebarItem 
              icon={<Plus />} 
              label="유사문제 생성" 
              active={activeTab === 'generate'} 
              onClick={() => setActiveTab('generate')} 
            />
            <SidebarItem 
              icon={<FileUp />} 
              label="PDF 문제 추출" 
              active={activeTab === 'upload'} 
              onClick={() => setActiveTab('upload')} 
            />
            <SidebarItem 
              icon={<History />} 
              label="작업 로그" 
              active={activeTab === 'logs'} 
              onClick={() => setActiveTab('logs')} 
            />
          </nav>

          <div className="p-4 border-t border-gray-200">
            <div className="flex items-center gap-3 p-2">
              <img src={user.photoURL || ''} className="w-8 h-8 rounded-full" alt="profile" referrerPolicy="no-referrer" />
              <div className="flex-1 overflow-hidden">
                <p className="text-sm font-medium text-gray-900 truncate">{user.displayName}</p>
                <p className="text-xs text-gray-500 truncate">{user.email}</p>
              </div>
            </div>
            <button 
              onClick={() => auth.signOut()}
              className="mt-4 w-full py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition"
            >
              로그아웃
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto p-8">
          <AnimatePresence mode="wait">
            {activeTab === 'dashboard' && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-8"
              >
                <header className="flex justify-between items-center">
                  <div>
                    <h1 className="text-3xl font-bold text-gray-900">대시보드</h1>
                    <p className="text-gray-500">전체 문제 현황 및 통계</p>
                  </div>
                  <div className="flex gap-4">
                 </div>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <StatCard title="전체 문제" value={problems.length} icon={<Database className="text-blue-600" />} />
                  <StatCard title="원본 문제" value={problems.filter(p => p.source_type !== 'AI 생성').length} icon={<CheckCircle className="text-green-600" />} />
                  <StatCard title="생성된 유사 문제" value={problems.filter(p => p.source_type === 'AI 생성').length} icon={<RefreshCw className="text-purple-600" />} />
                </div>

                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-gray-200 flex justify-between items-center">
                    <h2 className="font-bold text-gray-900">최근 생성 로그</h2>
                    <button onClick={() => setActiveTab('logs')} className="text-sm text-blue-600 hover:underline">전체 보기</button>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {logs.slice(0, 5).map(log => (
                      <div key={log.id} className="p-4 flex items-center gap-4">
                        <StatusIcon status={log.status} />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900">{log.message}</p>
                          <div className="mt-1 w-full bg-gray-100 rounded-full h-1.5">
                            <div 
                              className="bg-blue-600 h-1.5 rounded-full transition-all duration-500" 
                              style={{ width: `${log.progress}%` }}
                            />
                          </div>
                        </div>
                        <span className="text-xs text-gray-400">
                          {new Date(log.createdAt?.seconds * 1000).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'bank' && (
              <motion.div 
                key="bank"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex gap-6 h-full"
              >
                {/* Tree Sidebar */}
                <div className="w-64 bg-white p-6 rounded-2xl border border-gray-200 shadow-sm overflow-y-auto">
                  <h2 className="text-lg font-bold text-gray-900 mb-6">분류 체계</h2>
                  <div className="space-y-4">
                    <button 
                      onClick={() => setFilter({ subject: '', large_unit: '', source_id: '' })}
                      className={`w-full text-left font-medium ${!filter.subject ? 'text-blue-600' : 'text-gray-600'}`}
                    >
                      전체 문제
                    </button>
                    {Object.entries(SUBJECT_STRUCTURE).map(([subject, units]) => (
                      <div key={subject} className="space-y-2">
                        <button 
                          onClick={() => setFilter({ subject, large_unit: '', source_id: '' })}
                          className={`w-full text-left font-semibold ${filter.subject === subject && !filter.large_unit ? 'text-blue-600' : 'text-gray-700'}`}
                        >
                          {subject}
                        </button>
                        <div className="pl-4 space-y-1">
                          {units.map(unit => (
                            <button 
                              key={unit}
                              onClick={() => setFilter({ subject, large_unit: unit, source_id: '' })}
                              className={`w-full text-left text-sm ${filter.large_unit === unit ? 'text-blue-600' : 'text-gray-500'}`}
                            >
                              {unit}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Main Content */}
                <div className="flex-1 space-y-6">
                  <header>
                    <h1 className="text-3xl font-bold text-gray-900">문제은행</h1>
                    <p className="text-gray-500">
                      {filter.subject ? `${filter.subject} ${filter.large_unit ? `> ${filter.large_unit}` : ''}` : '전체 문제 목록'}
                    </p>
                  </header>

                  <div className="bg-white p-4 rounded-2xl border border-gray-200 shadow-sm relative">
                    <Search className="absolute left-7 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input 
                      type="text" 
                      placeholder="문제 내용, 출처, 번호 검색..." 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 bg-gray-50 border-none rounded-xl focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    {problems
                      .filter(p => {
                        const matchesSubject = !filter.subject || p.subject === filter.subject;
                        const matchesUnit = !filter.large_unit || p.large_unit === filter.large_unit;
                        const matchesSearch = !searchQuery || 
                          p.problem_text.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          p.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          p.large_unit.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          p.source_id?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          p.problem_number?.toLowerCase().includes(searchQuery.toLowerCase());
                        return matchesSubject && matchesUnit && matchesSearch;
                      })
                      .map((problem, idx) => (
                      <ProblemCard key={problem.problem_id || idx} problem={problem} onDelete={(id) => setProblemToDelete(id)} />
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'generate' && (
              <motion.div 
                key="generate"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <header>
                  <h1 className="text-3xl font-bold text-gray-900">유사문제 생성</h1>
                  <p className="text-gray-500">원본 문제를 선택하여 유사한 평가원 스타일 문제를 생성합니다.</p>
                </header>

                <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="font-bold">원본 문제 선택 ({selectedProblemIds.length}개 선택됨)</h2>
                    <button 
                      onClick={() => setSelectedProblemIds([])}
                      className="text-xs text-gray-500 hover:text-blue-600"
                    >
                      선택 해제
                    </button>
                  </div>
                  <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2">
                    {problems.filter(p => p.source_type !== 'AI 생성').map(p => (
                      <div 
                        key={p.problem_id} 
                        className={`flex items-start gap-4 p-4 border rounded-xl transition cursor-pointer ${
                          selectedProblemIds.includes(p.problem_id!) ? 'border-blue-600 bg-blue-50' : 'border-gray-100 hover:bg-gray-50'
                        }`}
                        onClick={() => {
                          if (selectedProblemIds.includes(p.problem_id!)) {
                            setSelectedProblemIds(selectedProblemIds.filter(id => id !== p.problem_id));
                          } else {
                            setSelectedProblemIds([...selectedProblemIds, p.problem_id!]);
                          }
                        }}
                      >
                        <div className={`mt-1 w-5 h-5 rounded border flex items-center justify-center ${
                          selectedProblemIds.includes(p.problem_id!) ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white'
                        }`}>
                          {selectedProblemIds.includes(p.problem_id!) && <CheckCircle className="w-4 h-4 text-white" />}
                        </div>
                        <div className="flex-1">
                          <div className="flex gap-2 mb-2">
                            <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-xs font-bold rounded">{p.subject}</span>
                            <span className="px-2 py-0.5 bg-gray-50 text-gray-600 text-xs font-bold rounded">{p.large_unit}</span>
                          </div>
                          <p className="text-sm text-gray-800 line-clamp-2">{p.problem_text}</p>
                        </div>
                        <button 
                          onClick={(e) => { e.stopPropagation(); setProblemToDelete(p.problem_id!); }}
                          className="text-gray-400 hover:text-red-600 transition-colors"
                          title="문제 삭제"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button 
                    onClick={() => handleBatchGenerate(problems.filter(p => selectedProblemIds.includes(p.problem_id!)))}
                    disabled={loading || selectedProblemIds.length === 0}
                    className="mt-6 w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-200"
                  >
                    {loading ? <Loader2 className="animate-spin" /> : <RefreshCw className="w-5 h-5" />}
                    선택한 {selectedProblemIds.length}개의 문제로 유사 문제 일괄 생성하기
                  </button>
                </div>
              </motion.div>
            )}

            {activeTab === 'upload' && (
              <motion.div 
                key="upload"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <header>
                  <h1 className="text-3xl font-bold text-gray-900">PDF 문제 추출</h1>
                  <p className="text-gray-500">여러 개의 PDF 파일을 동시에 업로드하여 문제를 추출합니다.</p>
                </header>

                <div className="bg-white p-8 rounded-2xl border border-dashed border-gray-300 shadow-sm text-center">
                  <FileUp className="w-12 h-12 text-blue-600 mx-auto mb-4" />
                  <h2 className="text-lg font-bold mb-2">PDF 파일 업로드</h2>
                  <p className="text-gray-500 mb-6">여러 개의 PDF 파일을 선택하세요.</p>
                  <label className={`px-6 py-3 text-white rounded-xl cursor-pointer transition font-semibold ${loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}>
                    {loading ? '처리 중...' : '파일 선택'}
                    <input type="file" className="hidden" accept=".pdf" multiple disabled={loading} onChange={async (e) => {
                      const files = e.target.files;
                      if (!files) return;
                      
                      for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        const fakeEvent = {
                          target: {
                            files: {
                              0: file,
                              length: 1,
                              item: (index: number) => index === 0 ? file : null
                            }
                          }
                        } as unknown as React.ChangeEvent<HTMLInputElement>;
                        
                        await handlePdfUpload(fakeEvent);
                      }
                    }} />
                  </label>
                </div>

                {currentPdfUrl && (
                  <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm">
                    <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-blue-600" />
                      현재 처리 중인 PDF
                    </h3>
                    <div className="w-full h-[600px] rounded-xl overflow-hidden border border-gray-200 bg-gray-50">
                      <embed src={`${currentPdfUrl}#toolbar=0&navpanes=0&scrollbar=0`} type="application/pdf" className="w-full h-full" />
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'logs' && (
              <motion.div 
                key="logs"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <header>
                  <h1 className="text-3xl font-bold text-gray-900">작업 로그</h1>
                  <p className="text-gray-500">시스템 작업 진행 상황 및 이력</p>
                </header>

                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="divide-y divide-gray-100">
                    {logs.map(log => (
                      <div key={log.id} className="p-6 flex items-center gap-6">
                        <StatusIcon status={log.status} />
                        <div className="flex-1">
                          <div className="flex justify-between mb-2">
                            <p className="font-semibold text-gray-900">{log.message}</p>
                            <span className="text-sm text-gray-500">
                              {log.createdAt instanceof Date 
                                ? log.createdAt.toLocaleString() 
                                : log.createdAt?.seconds 
                                  ? new Date(log.createdAt.seconds * 1000).toLocaleString() 
                                  : ''}
                            </span>
                          </div>
                          <div className="w-full bg-gray-100 rounded-full h-2">
                            <div 
                              className={`h-2 rounded-full transition-all duration-700 ${
                                log.status === 'failed' ? 'bg-red-500' : 
                                log.status === 'completed' ? 'bg-green-500' : 'bg-blue-600'
                              }`}
                              style={{ width: `${log.progress}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {problemToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl"
            >
              <h3 className="text-lg font-bold text-gray-900 mb-2">문제 삭제</h3>
              <p className="text-gray-600 mb-6">정말 이 문제를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.</p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setProblemToDelete(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition"
                >
                  취소
                </button>
                <button
                  onClick={executeDeleteProblem}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition"
                >
                  삭제
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </ErrorBoundary>
  );
}

// --- Sub-components ---

function SidebarItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition ${
        active ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'
      }`}
    >
      {React.cloneElement(icon as React.ReactElement, { className: 'w-5 h-5' })}
      <span className="font-medium">{label}</span>
      {active && <ChevronRight className="ml-auto w-4 h-4" />}
    </button>
  );
}

function StatCard({ title, value, icon }: { title: string, value: number, icon: React.ReactNode }) {
  return (
    <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm flex items-center gap-4">
      <div className="p-3 bg-gray-50 rounded-xl">
        {React.cloneElement(icon as React.ReactElement, { className: 'w-6 h-6' })}
      </div>
      <div>
        <p className="text-sm text-gray-500">{title}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: GenerationLog['status'] }) {
  switch (status) {
    case 'processing': return <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />;
    case 'completed': return <CheckCircle className="w-6 h-6 text-green-600" />;
    case 'failed': return <XCircle className="w-6 h-6 text-red-600" />;
    default: return <div className="w-6 h-6 rounded-full bg-gray-200" />;
  }
}

const ProblemCard: React.FC<{ problem: Problem, onDelete: (id: string) => void }> = ({ problem, onDelete }) => {
  const [showExplanation, setShowExplanation] = useState(false);

  return (
    <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4 relative overflow-hidden group hover:border-blue-300 transition-colors">
      {problem.source_type === 'AI 생성' && (
        <div className="absolute top-0 left-0 w-1.5 h-full bg-purple-500" />
      )}
      
      <div className="flex justify-between items-start gap-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center text-[11px] font-bold rounded-lg uppercase tracking-wider bg-gray-100 text-gray-700 px-2.5 py-1.5 shadow-sm border border-gray-200">
            <span className="text-blue-700">{problem.subject}</span>
            {problem.large_unit && (
              <>
                <ChevronRight className="w-3 h-3 mx-1 text-gray-400" />
                <span>{problem.large_unit}</span>
              </>
            )}
            {problem.medium_unit && (
              <>
                <ChevronRight className="w-3 h-3 mx-1 text-gray-400" />
                <span>{problem.medium_unit}</span>
              </>
            )}
            {problem.small_unit && (
              <>
                <ChevronRight className="w-3 h-3 mx-1 text-gray-400" />
                <span>{problem.small_unit}</span>
              </>
            )}
          </div>
          <span className={`px-2.5 py-1.5 text-[11px] font-bold rounded-lg uppercase tracking-wider shadow-sm border ${
            problem.source_type !== 'AI 생성' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-purple-50 text-purple-700 border-purple-200'
          }`}>
            {problem.source_type !== 'AI 생성' ? '원본' : '유사문제'}
          </span>
        </div>
        <div className="text-right flex flex-col items-end">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest bg-gray-50 px-2 py-0.5 rounded">
              {problem.source_id || '출처 미상'}
            </span>
            <button 
              onClick={() => onDelete(problem.problem_id!)}
              className="text-gray-400 hover:text-red-600 transition-colors"
              title="문제 삭제"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <span className="text-2xl font-black text-gray-200 mt-1 select-none">
            #{problem.problem_number || '??'}
          </span>
        </div>
      </div>
      
      <div className="flex gap-4 items-start">
        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gray-900 text-white flex items-center justify-center font-bold text-lg shadow-lg shadow-gray-200">
          {problem.problem_number || '?'}
        </div>
        <div className="flex-1 pt-1">
          <p className="text-gray-900 font-semibold text-lg leading-relaxed whitespace-pre-wrap">
            {problem.problem_text}
          </p>
        </div>
      </div>
      
      <div className="grid grid-cols-1 gap-3 mt-6">
        {problem.options.map((opt, i) => (
          <div key={i} className="flex gap-4 p-4 bg-gray-50 rounded-2xl text-base text-gray-800 hover:bg-gray-100 transition-colors border border-transparent hover:border-gray-200">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-gray-200 flex items-center justify-center text-xs font-bold text-blue-600 shadow-sm">
              {i + 1}
            </span>
            <span className="flex-1">{opt}</span>
          </div>
        ))}
      </div>

      <div className="pt-6 border-t border-gray-100 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-gray-500 uppercase tracking-widest">정답</span>
          <span className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold shadow-md shadow-blue-100">
            {problem.answer}
          </span>
        </div>
        <button 
          onClick={() => setShowExplanation(!showExplanation)}
          className="px-4 py-2 text-sm font-bold text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all flex items-center gap-2"
        >
          {showExplanation ? '해설 숨기기' : '상세 해설 보기'}
          <ChevronRight className={`w-4 h-4 transition-transform ${showExplanation ? 'rotate-90' : ''}`} />
        </button>
      </div>

      <AnimatePresence>
        {showExplanation && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-4 p-5 bg-blue-50 rounded-2xl text-sm text-blue-900 leading-relaxed border border-blue-100">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1.5 h-4 bg-blue-500 rounded-full" />
                <p className="font-bold text-blue-800">정교한 해설 및 분석</p>
              </div>
              <p className="whitespace-pre-wrap">{problem.explanation_text}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface Problem {
  problem_id?: string;
  source_type: string; // '내신 기출', '모의고사', '교재', 'AI 생성'
  source_id: string; // e.g., '2024학년도 대학수학능력시험'
  problem_number: string;
  created_at: string;
  updated_at: string;

  subject: string;
  grade: string;
  large_unit: string;
  medium_unit: string;
  small_unit: string;
  detail_type: string[];
  textbook_id: string | null;
  difficulty: number;
  tags: string[];
  related_concepts: string[];

  problem_text: string;
  options: string[];
  answer: string;
  explanation_text: string;
  problem_image_urls: string[];
  explanation_image_urls: string[];

  average_correct_rate: number;
  average_solve_time: number;
  total_solve_count: number;
  last_calculated_at: string | null;
  
  originalId?: string; // For generated problems to link back
}

const SUBJECT_HIERARCHY = `
분야 및 과목 체계 (반드시 이 중 하나를 선택):
1. 국어: 독서, 문학, 화법과 작문, 언어와 매체
2. 수학: 수학Ⅰ, 수학Ⅱ, 확률과 통계, 미적분, 기하
3. 영어: 영어Ⅰ, 영어Ⅱ (듣기, 독해)
4. 과학: 물리학Ⅰ, 물리학Ⅱ, 화학Ⅰ, 화학Ⅱ, 생명과학Ⅰ, 생명과학Ⅱ, 지구과학Ⅰ, 지구과학Ⅱ
5. 사회: 생활과 윤리, 윤리와 사상, 한국지리, 세계지리, 동아시아사, 세계사, 경제, 정치와 법, 사회·문화
`;

export async function generateSimilarProblems(originalProblem: Problem, count: number = 1): Promise<Problem[]> {
  const model = ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: `
      다음 원본 문제를 바탕으로 '평가원 스타일'의 유사 문제를 ${count}개 생성해줘.
      원본 문제의 핵심 원리와 난이도를 유지하면서, 수치나 상황을 적절히 변형해야 해.
      특히 평가원 특유의 정교한 문체와 논리적 구조를 유지해줘.
      정교한 해설도 함께 포함해줘.

      원본 문제 정보:
      출처: ${originalProblem.source_id || '알 수 없음'}
      번호: ${originalProblem.problem_number || 'N/A'}
      분야: ${originalProblem.subject}
      대단원: ${originalProblem.large_unit}
      내용: ${originalProblem.problem_text}
      보기: ${originalProblem.options.join(', ')}
      정답: ${originalProblem.answer}
      해설: ${originalProblem.explanation_text}
    `,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            problem_number: { type: Type.STRING },
            source_id: { type: Type.STRING },
            subject: { type: Type.STRING },
            grade: { type: Type.STRING },
            large_unit: { type: Type.STRING },
            medium_unit: { type: Type.STRING },
            small_unit: { type: Type.STRING },
            detail_type: { type: Type.ARRAY, items: { type: Type.STRING } },
            difficulty: { type: Type.NUMBER },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            problem_text: { type: Type.STRING },
            options: { type: Type.ARRAY, items: { type: Type.STRING } },
            answer: { type: Type.STRING },
            explanation_text: { type: Type.STRING },
          },
          required: ["problem_number", "source_id", "subject", "grade", "large_unit", "medium_unit", "small_unit", "detail_type", "difficulty", "tags", "problem_text", "options", "answer", "explanation_text"]
        }
      }
    }
  });

  const response = await model;
  const generated = JSON.parse(response.text);
  
  return generated.map((p: any) => ({
    ...p,
    problem_number: originalProblem.problem_number ? `${originalProblem.problem_number}-유사` : "유사",
    source_id: `유사 문제 (원본: ${originalProblem.source_id || '알 수 없음'})`,
    source_type: 'AI 생성',
    originalId: originalProblem.problem_id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    textbook_id: null,
    related_concepts: [],
    problem_image_urls: [],
    explanation_image_urls: [],
    average_correct_rate: 0,
    average_solve_time: 0,
    total_solve_count: 0,
    last_calculated_at: null
  }));
}

export async function parsePdfToProblems(base64Pdf: string): Promise<Problem[]> {
  const model = ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [
      {
        inlineData: {
          mimeType: "application/pdf",
          data: base64Pdf
        }
      },
      {
        text: `
          이 PDF 조각에서 실제 '문제'들을 추출해서 정형화된 데이터로 만들어줘. 
          
          [매우 중요한 주의사항]
          1. 표지, 안내문, 특히 **'정답표(문항 번호와 정답만 나열된 표)'**만 있는 페이지에서는 절대 문제를 억지로 만들어내지 마.
          2. 실제 문제의 지문(발문)과 선지 내용이 명확히 존재하는 경우에만 추출해. 
          3. 내용이 없는 문제를 "정답 O번 문항" 식으로 지어내면 안 돼. 문제가 없으면 빈 배열 [] 을 반환해.
          4. **절대 문제를 누락하지 마.** 페이지 내에 존재하는 모든 객관식/주관식 문제를 빠짐없이 추출해야 해.

          각 문제에 대해 다음 정보를 '반드시' 그리고 '정확히' 추출해야 해:

          1. problem_number: 문제 번호. 숫자만 추출해 (예: "1", "2", "39"). 문제 옆에 크게 써있는 숫자를 찾아.
          2. source_id: 시험 출처. 페이지 상단(헤더), 하단(푸터), 또는 시험지 첫 페이지의 큰 제목에서 찾아줘. 
             (예: "2024학년도 대학수학능력시험", "2023년 6월 고3 모의평가")
             만약 해당 페이지에 정보가 없다면, 문맥상 가장 적절한 시험 명칭을 추론하거나 비워둬.
          3. subject: 과목명. 아래 '분야 및 과목 체계'의 대분류 중 하나를 선택해.
          4. grade: 학년. (예: "고1", "고2", "고3", "공통")
          5. large_unit: 대단원. 아래 '분야 및 과목 체계'의 소분류 중 하나를 선택해.
          6. medium_unit: 중단원. 문맥상 추론해줘.
          7. small_unit: 소단원. 문맥상 추론해줘.
          8. detail_type: 세부 유형 태그 배열 (예: ["그래프 해석", "개념 적용"]).
          9. difficulty: 예상 난이도 (0.0 ~ 1.0 사이의 소수).
          10. tags: 핵심 키워드 태그 배열.
          11. problem_text: 문제 본문(발문 및 지문). 그림이나 표가 있다면 텍스트로 최대한 상세히 묘사해줘. "다음 글을 읽고 물음에 답하시오." 같은 텍스트도 포함해.
          12. options: 5지 선지. "①, ②, ③, ④, ⑤" 기호는 제외하고 실제 선지의 '내용(텍스트)'만 배열로 담아줘. (예: ["수요가 증가한다", "공급이 감소한다", ...]) 절대 "1", "2", "3" 처럼 번호만 넣지 마. 주관식인 경우 빈 배열 [] 을 반환해.
          13. answer: 정답. 숫자 하나만 적어 (예: "1", "3"). 본문에 정답이 안 적혀있으면 문맥상 추론하거나 빈 문자열로 둬.
          14. explanation_text: 문제의 핵심 원리와 풀이 과정을 상세히 작성해줘.

          ${SUBJECT_HIERARCHY}

          중요: 
          - 한 페이지에 여러 문제가 있을 수 있어. **보이는 모든 문제를 하나도 빠짐없이 추출해줘.**
          - 문제 번호가 누락되지 않도록 주의해.
          - 시험 출처는 모든 문제에 동일하게 적용될 가능성이 높아.

          만약 실제 문제가 전혀 없다면 빈 배열 [] 을 반환해.
        `
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            problem_number: { type: Type.STRING },
            source_id: { type: Type.STRING },
            subject: { type: Type.STRING },
            grade: { type: Type.STRING },
            large_unit: { type: Type.STRING },
            medium_unit: { type: Type.STRING },
            small_unit: { type: Type.STRING },
            detail_type: { type: Type.ARRAY, items: { type: Type.STRING } },
            difficulty: { type: Type.NUMBER },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            problem_text: { type: Type.STRING },
            options: { type: Type.ARRAY, items: { type: Type.STRING } },
            answer: { type: Type.STRING },
            explanation_text: { type: Type.STRING },
          },
          required: ["problem_number", "source_id", "subject", "grade", "large_unit", "medium_unit", "small_unit", "detail_type", "difficulty", "tags", "problem_text", "options", "answer", "explanation_text"]
        }
      }
    }
  });

  const response = await model;
  const text = response.text || "[]";
  const parsed = JSON.parse(text);
  
  return parsed.map((p: any) => ({
    ...p,
    source_type: '모의고사', // Default for PDF uploads
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    textbook_id: null,
    related_concepts: [],
    problem_image_urls: [],
    explanation_image_urls: [],
    average_correct_rate: 0,
    average_solve_time: 0,
    total_solve_count: 0,
    last_calculated_at: null
  }));
}

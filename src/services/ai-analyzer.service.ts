
import { Injectable } from '@angular/core';
import { Record } from '../models/record.model';
import { GoogleGenAI, GenerateContentResponse } from '@google/genai';

@Injectable({
  providedIn: 'root',
})
export class AiAnalyzerService {
  private ai: GoogleGenAI | null = null;

  constructor() {
    // The API key MUST be obtained from an environment variable.
    // This is a placeholder; in a real app, you would use a secure way to provide it.
    if (process.env.API_KEY) {
        this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    }
  }

  analyzeDuplicates(records: Record[]): { name: string; count: number }[] {
    const counts: { [key: string]: number } = {};
    records.forEach(record => {
      counts[record.nombre] = (counts[record.nombre] || 0) + 1;
    });

    return Object.entries(counts)
      .filter(([, count]) => count > 1)
      .map(([name, count]) => ({ name, count }));
  }

  findPeakHours(records: Record[]): { hour: number; count: number }[] {
    const hours: { [key: number]: number } = {};
    records.forEach(record => {
      const hour = record.timestamp.getHours();
      hours[hour] = (hours[hour] || 0) + 1;
    });
    return Object.entries(hours).map(([hour, count]) => ({
      hour: parseInt(hour, 10),
      count,
    }));
  }

  async getInsightsWithGemini(records: Record[]): Promise<string> {
    if (!this.ai) {
      return Promise.resolve("Gemini API key not configured.");
    }

    const simplifiedRecords = records.map(r => `${r.timestamp.toLocaleTimeString()} - ${r.nombre} (${r.tipo})`).join('\n');
    const prompt = `Analyze the following attendance log and provide 3 key insights. For example, mention peak registration times, potential duplicate entries for specific individuals, or the ratio of identified vs. unidentified scans. Keep the response concise.\n\nLog:\n${simplifiedRecords}`;

    try {
        const response: GenerateContentResponse = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        return response.text;
    } catch (error) {
        console.error("Error calling Gemini API:", error);
        return "Failed to get insights from AI model.";
    }
  }
}

import OpenAI from "openai";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { text: "", error: "OpenAI API key is not configured." },
      { status: 200 }
    );
  }

  try {
    const formData = await request.formData();
    const audio = formData.get("audio");

    if (!(audio instanceof File)) {
      return NextResponse.json({ text: "", error: "No audio file was received." }, { status: 200 });
    }

    const client = new OpenAI({ apiKey });
    const transcription = await client.audio.transcriptions.create({
      file: audio,
      model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
    });

    return NextResponse.json({ text: transcription.text || "" });
  } catch {
    return NextResponse.json(
      {
        text: "",
        error:
          "I could not transcribe the microphone recording. Check API credits, microphone permission, and network access."
      },
      { status: 200 }
    );
  }
}

import { describe, expect, it } from "vitest";
import {
  ROSTER_DARKEST,
  ROSTER_LIGHTEST,
  ROSTER_ROWS,
  ROSTER_TONES,
  rosterSessionLabel,
  rosterSessionOrder,
  rosterTeacherShade,
  rosterTime,
} from "@/domain/roster";

describe("bảng tổng quan Ghi danh theo buổi", () => {
  it("tên buổi ghép ca với thứ, Chủ nhật là thứ 7 của tuần", () => {
    expect(rosterSessionLabel("Ca tối", 1)).toBe("Tối Thứ 2");
    expect(rosterSessionLabel("Ca sáng", 6)).toBe("Sáng Thứ 7");
    expect(rosterSessionLabel("Ca chiều", 7)).toBe("Chiều Chủ nhật");
    expect(ROSTER_ROWS).toBe(8);
  });

  it("giờ trên tiêu đề viết kiểu 19h00", () => {
    expect(rosterTime("19:00:00")).toBe("19h00");
    expect(rosterTime("08:05")).toBe("08h05");
  });

  it("thứ tự: theo từng ngày từ Thứ 2 đến Chủ nhật, trong ngày Sáng rồi Chiều rồi Tối", () => {
    const sessions: [string, number][] = [
      ["Ca chiều", 7],
      ["Ca sáng", 7],
      ["Ca tối", 7],
      ["Ca chiều", 6],
      ["Ca tối", 3],
      ["Ca sáng", 6],
      ["Ca tối", 1],
      ["Ca tối", 6],
    ];
    const ordered = sessions.sort((a, b) => rosterSessionOrder(...a) - rosterSessionOrder(...b)).map((s) => rosterSessionLabel(...s));
    expect(ordered).toEqual([
      "Tối Thứ 2",
      "Tối Thứ 4",
      "Sáng Thứ 7",
      "Chiều Thứ 7",
      "Tối Thứ 7",
      "Sáng Chủ nhật",
      "Chiều Chủ nhật",
      "Tối Chủ nhật",
    ]);
  });

  const parse = (color: string) => color.slice(6, -1).split(" ").map(Number) as [number, number, number];

  it("mỗi giáo viên một tông riêng; ba tông đầu là vàng, xanh dương, xanh ngọc như Thời khóa biểu", () => {
    const hues = Array.from({ length: ROSTER_TONES }, (_, teacher) => parse(rosterTeacherShade(teacher, 0, 1).header)[2]);
    expect(new Set(hues).size).toBe(ROSTER_TONES);
    expect(hues.slice(0, 3)).toEqual([75, 255, 185]);
    // Hết tông thì quay vòng.
    expect(rosterTeacherShade(ROSTER_TONES, 0, 1)).toEqual(rosterTeacherShade(0, 0, 1));
  });

  it("các buổi của cùng một giáo viên: cùng tông, đậm dần và rực dần từ buổi đầu tới buổi cuối", () => {
    for (let teacher = 0; teacher < ROSTER_TONES; teacher++) {
      const shades = Array.from({ length: 7 }, (_, position) => rosterTeacherShade(teacher, position, 7));
      const headers = shades.map((shade) => parse(shade.header));
      expect(new Set(shades.map((shade) => shade.header)).size).toBe(7);
      expect(new Set(headers.map(([, , hue]) => hue)).size).toBe(1);
      expect(headers[0]![0]).toBe(ROSTER_LIGHTEST);
      expect(headers[6]![0]).toBe(ROSTER_DARKEST);
      for (let i = 1; i < headers.length; i++) {
        expect(headers[i]![0]).toBeLessThan(headers[i - 1]![0]);
        expect(headers[i]![1]).toBeGreaterThan(headers[i - 1]![1]);
      }
      // Viền trên cùng tông, đậm hơn nền tiêu đề.
      for (const shade of shades) {
        expect(parse(shade.accent)[2]).toBe(parse(shade.header)[2]);
        expect(parse(shade.accent)[0]).toBeLessThan(parse(shade.header)[0]);
      }
    }
  });

  it("giáo viên chỉ có một buổi lấy mức đậm giữa; hai buổi thì nhạt nhất và đậm nhất", () => {
    expect(parse(rosterTeacherShade(0, 0, 1).header)[0]).toBe(0.855);
    expect(parse(rosterTeacherShade(0, 0, 2).header)[0]).toBe(ROSTER_LIGHTEST);
    expect(parse(rosterTeacherShade(0, 1, 2).header)[0]).toBe(ROSTER_DARKEST);
  });
});

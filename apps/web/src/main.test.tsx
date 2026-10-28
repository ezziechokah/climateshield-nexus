/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./main";

afterEach(() => localStorage.clear());

describe("farmer access screen", () => {
  it("shows registration fields and can switch to sign-in", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
    expect(screen.getByLabelText("Full name")).toBeTruthy();
    expect(screen.getByPlaceholderText("+2547...")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in to your farm" })).toBeTruthy();
    expect(screen.queryByLabelText("Full name")).toBeNull();
  });
});
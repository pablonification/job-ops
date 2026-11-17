import { describe, expect, it } from "vitest";
import { parseJobStreetSalary } from "../src/salary";

describe("JobStreet salary labels", () => {
  it("parses the Indonesian-locale range with dots and non-breaking spaces", () => {
    expect(
      parseJobStreetSalary("Rp 20.000.000 – Rp 30.000.000 per month"),
    ).toEqual({
      salary: "IDR 20,000,000–30,000,000 / month",
      salaryMinAmount: 20_000_000,
      salaryMaxAmount: 30_000_000,
      salaryCurrency: "IDR",
      salaryInterval: "monthly",
    });
  });

  it("parses the English-locale range with commas", () => {
    expect(
      parseJobStreetSalary("Rp 6,000,000 – Rp 7,000,000 per month"),
    ).toMatchObject({
      salaryMinAmount: 6_000_000,
      salaryMaxAmount: 7_000_000,
      salaryInterval: "monthly",
    });
  });

  it("parses a single amount, a hyphen range and other periods", () => {
    expect(parseJobStreetSalary("Rp 5.000.000 per month")).toMatchObject({
      salary: "IDR 5,000,000 / month",
      salaryMinAmount: 5_000_000,
      salaryMaxAmount: 5_000_000,
    });
    expect(
      parseJobStreetSalary("IDR 150.000.000 - 200.000.000 per year"),
    ).toMatchObject({
      salaryMinAmount: 150_000_000,
      salaryMaxAmount: 200_000_000,
      salaryInterval: "yearly",
    });
    expect(
      parseJobStreetSalary("Rp 50.000 – Rp 75.000 per hour"),
    ).toMatchObject({ salaryInterval: "hourly" });
    expect(parseJobStreetSalary("Rp 4.500.000 – Rp 5.500.000")).toMatchObject({
      salary: "IDR 4,500,000–5,500,000",
      salaryInterval: undefined,
    });
  });

  it("keeps other labels as text only", () => {
    for (const label of [
      "Rp 8 jt – Rp 10 jt per month",
      "Rp 3,5 – Rp 4,5 juta per month",
      "$1,000 – $2,000 per month",
      "Rp 5.000.000 per shift",
      "Rp 1.000,000 – Rp 2.000.000 per month",
      "Competitive salary",
    ]) {
      expect(parseJobStreetSalary(label)).toEqual({ salary: label });
    }
  });

  it("returns nothing for an empty label", () => {
    expect(parseJobStreetSalary("")).toEqual({});
    expect(parseJobStreetSalary(undefined)).toEqual({});
  });
});

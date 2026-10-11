"use server";

import { idOnly } from "@/lib/validation/common";
import { awardInput, criteriaInput, criteriaUpdate, undoInput } from "@/lib/validation/stars";
import { runAction } from "../action";
import * as stars from "../services/stars";

const ADMIN = "/admin";
const ALL = "/";

export const createCriteriaAction = async (input: unknown) => runAction(criteriaInput, input, stars.createCriteria, ADMIN);
export const updateCriteriaAction = async (input: unknown) =>
  runAction(criteriaUpdate, input, (a, d) => stars.updateCriteria(a, d.id, d.data), ADMIN);
export const deleteCriteriaAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => stars.deleteCriteria(a, d.id), ADMIN);

// Dùng chung cho Admin và GV: service kiểm tra quyền trên buổi học / học viên.
export const awardStarsAction = async (input: unknown) => runAction(awardInput, input, (a, d) => stars.awardStars(a, d), ALL);
export const undoStarAction = async (input: unknown) => runAction(undoInput, input, (a, d) => stars.undoStarLog(a, d.logId), ALL);

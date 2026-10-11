"use server";

import { idOnly } from "@/lib/validation/common";
import { centerInfoInput } from "@/lib/validation/rewards";
import { cancelReceiptInput, classFeeInput, discountInput, receiptInput } from "@/lib/validation/tuition";
import {
  accountEditInput,
  accountInput,
  classInput,
  classUpdate,
  courseInput,
  courseUpdate,
  enrollInput,
  holidayInput,
  leaveInput,
  newEnrollmentInput,
  lockInput,
  makeupAssignInput,
  purchaseInput,
  purchaseUpdate,
  resetPasswordInput,
  sendCredentialsInput,
  roomInput,
  roomUpdate,
  studentUpdate,
  teacherInput,
  teacherUpdate,
  timeSlotInput,
  syllabusInput,
  syllabusUpdate,
  teacherRateInput,
  teacherRateUpdate,
  timeSlotUpdate,
  timesheetAdjustInput,
  timesheetEntryInput,
  timesheetEntryUpdate,
  userIdInput,
} from "@/lib/validation/entities";
import { runAction } from "../action";
import * as accounts from "../services/accounts";
import * as catalog from "../services/catalog";
import * as finance from "../services/finance";
import * as syllabus from "../services/syllabus";
import * as teacherRates from "../services/teacher-rates";
import * as timesheet from "../services/timesheet";
import * as tuition from "../services/tuition";
import * as classes from "../services/classes";
import * as makeups from "../services/makeups";
import * as students from "../services/students";

// Mỗi action chỉ là vỏ: phiên + Zod ở runAction, phân quyền nằm trong service.
const ADMIN = "/admin";

export const createTeacherAction = async (input: unknown) => runAction(teacherInput, input, catalog.createTeacher, ADMIN);
export const updateTeacherAction = async (input: unknown) =>
  runAction(teacherUpdate, input, (a, d) => catalog.updateTeacher(a, d.id, d.data), ADMIN);
export const deleteTeacherAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => catalog.deleteTeacher(a, d.id), ADMIN);

export const updateStudentAction = async (input: unknown) =>
  runAction(studentUpdate, input, (a, d) => students.updateStudent(a, d.id, d.data), ADMIN);
export const deleteStudentAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => classes.deleteStudent(a, d.id), ADMIN);

export const createCourseAction = async (input: unknown) => runAction(courseInput, input, catalog.createCourse, ADMIN);
export const updateCourseAction = async (input: unknown) =>
  runAction(courseUpdate, input, (a, d) => catalog.updateCourse(a, d.id, d.data), ADMIN);
export const deleteCourseAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => catalog.deleteCourse(a, d.id), ADMIN);

export const createRoomAction = async (input: unknown) => runAction(roomInput, input, catalog.createRoom, ADMIN);
export const updateRoomAction = async (input: unknown) =>
  runAction(roomUpdate, input, (a, d) => catalog.updateRoom(a, d.id, d.data), ADMIN);
export const deleteRoomAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => catalog.deleteRoom(a, d.id), ADMIN);

export const createTimeSlotAction = async (input: unknown) => runAction(timeSlotInput, input, catalog.createTimeSlot, ADMIN);
export const updateTimeSlotAction = async (input: unknown) =>
  runAction(timeSlotUpdate, input, (a, d) => catalog.updateTimeSlot(a, d.id, d.data), ADMIN);
export const deleteTimeSlotAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => catalog.deleteTimeSlot(a, d.id), ADMIN);


export const createTimesheetEntryAction = async (input: unknown) =>
  runAction(timesheetEntryInput, input, timesheet.createTimesheetEntry, ADMIN);
export const updateTimesheetEntryAction = async (input: unknown) =>
  runAction(timesheetEntryUpdate, input, (a, { id, ...data }) => timesheet.updateTimesheetEntry(a, id, data), ADMIN);
export const deleteTimesheetEntryAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => timesheet.deleteTimesheetEntry(a, d.id), ADMIN);
export const adjustSessionTimesheetAction = async (input: unknown) =>
  runAction(timesheetAdjustInput, input, timesheet.adjustSessionTimesheet, ADMIN);

export const createTeacherRateAction = async (input: unknown) => runAction(teacherRateInput, input, teacherRates.createTeacherRate, ADMIN);
export const updateTeacherRateAction = async (input: unknown) =>
  runAction(teacherRateUpdate, input, (a, d) => teacherRates.updateTeacherRate(a, d.id, d.data), ADMIN);
export const deleteTeacherRateAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => teacherRates.deleteTeacherRate(a, d.id), ADMIN);

export const createPurchaseAction = async (input: unknown) => runAction(purchaseInput, input, finance.createPurchase, ADMIN);
export const updatePurchaseAction = async (input: unknown) =>
  runAction(purchaseUpdate, input, (a, d) => finance.updatePurchase(a, d.id, d.data), ADMIN);
export const deletePurchaseAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => finance.deletePurchase(a, d.id), ADMIN);

export const createHolidayAction = async (input: unknown) => runAction(holidayInput, input, catalog.createHoliday, ADMIN);
export const deleteHolidayAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => catalog.deleteHoliday(a, d.id), ADMIN);

export const createClassAction = async (input: unknown) => runAction(classInput, input, classes.createClass, ADMIN);
export const updateClassAction = async (input: unknown) =>
  runAction(classUpdate, input, (a, d) => classes.updateClass(a, d.id, d.data), ADMIN);
export const deleteClassAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => classes.deleteClass(a, d.id), ADMIN);

// classId được gắn sẵn bằng .bind() ở trang; vẫn đi qua Zod và kiểm tra quyền như mọi dữ liệu từ client.
const withClassId = (classId: unknown, input: unknown) => ({ ...(typeof input === "object" ? input : null), classId });

export const enrollStudentAction = async (classId: unknown, input: unknown) =>
  runAction(enrollInput, withClassId(classId, input), classes.enrollStudent, ADMIN);
/** Xếp lớp cho học viên đang chờ: lớp do người dùng chọn trong form. */
export const placeStudentAction = async (input: unknown) => runAction(enrollInput, input, classes.enrollStudent, ADMIN);
/** Học viên mới nhập ở Ghi danh: tạo học viên rồi ghi danh (hoặc để chờ lớp) trong một giao dịch. */
export const enrollNewStudentAction = async (input: unknown) =>
  runAction(newEnrollmentInput, input, (a, d) => classes.enrollNewStudent(a, d), ADMIN);
export const assignMakeupAction = async (input: unknown) => runAction(makeupAssignInput, input, (a, d) => makeups.assignMakeup(a, d), ADMIN);
export const cancelMakeupAction = async (input: unknown) => runAction(idOnly, input, (a, d) => makeups.cancelMakeup(a, d.id), ADMIN);
export const leaveEnrollmentAction = async (input: unknown) => runAction(leaveInput, input, classes.leaveEnrollment, ADMIN);
export const deleteEnrollmentAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => classes.deleteEnrollment(a, d.id), ADMIN);

export const createAccountAction = async (input: unknown) => runAction(accountInput, input, accounts.createAccount, ADMIN);
export const updateAccountAction = async (input: unknown) => runAction(accountEditInput, input, accounts.updateAccount, ADMIN);
export const resetPasswordAction = async (input: unknown) =>
  runAction(resetPasswordInput, input, (a, d) => accounts.resetAccountPassword(a, d.id, d.password, d.mustChange), ADMIN);
export const sendAccountCredentialsAction = async (input: unknown) =>
  runAction(sendCredentialsInput, input, (a, d) => accounts.sendAccountCredentials(a, d.id, d.password), ADMIN);
export const lockAccountAction = async (input: unknown) =>
  runAction(lockInput, input, (a, d) => accounts.setAccountLocked(a, d.id, d.locked), ADMIN);
export const deleteAccountAction = async (input: unknown) =>
  runAction(userIdInput, input, (a, d) => accounts.deleteAccount(a, d.id), ADMIN);
export const resetTwoFactorAction = async (input: unknown) =>
  runAction(userIdInput, input, (a, d) => accounts.resetAccountTwoFactor(a, d.id), ADMIN);

const TUITION = "/admin/tuition";
export const setClassFeeAction = async (input: unknown) => runAction(classFeeInput, input, tuition.setClassFee, TUITION);
export const setDiscountAction = async (input: unknown) => runAction(discountInput, input, tuition.setDiscount, TUITION);
export const createReceiptAction = async (input: unknown) => runAction(receiptInput, input, tuition.createReceipt, TUITION);
export const cancelReceiptAction = async (input: unknown) => runAction(cancelReceiptInput, input, tuition.cancelReceipt, TUITION);
export const deleteReceiptAction = async (input: unknown) => runAction(idOnly, input, (a, d) => tuition.deleteReceipt(a, d.id), TUITION);
export const updateCenterInfoAction = async (input: unknown) => runAction(centerInfoInput, input, tuition.updateCenterInfo, ADMIN);

const SYLLABUS = "/admin/syllabus";
export const createSyllabusLessonAction = async (input: unknown) => runAction(syllabusInput, input, syllabus.createLesson, SYLLABUS);
export const updateSyllabusLessonAction = async (input: unknown) =>
  runAction(syllabusUpdate, input, (a, d) => syllabus.updateLesson(a, d.id, d.data), SYLLABUS);
export const deleteSyllabusLessonAction = async (input: unknown) => runAction(idOnly, input, (a, d) => syllabus.deleteLesson(a, d.id), SYLLABUS);
